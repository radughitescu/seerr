import { MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { clients } from '@server/lib/liveStatus/sources';
import { getSettings } from '@server/lib/settings';
import {
  checkScopeShape,
  deleteContext,
  episodeKey,
  episodeLabel,
  loadContext,
  ServiceError,
  type ActionContext,
  type Scope,
} from './actions';
import { isExtraFile, mapFilesToEpisodes } from './fileMap';

export type DeletePreview = {
  files: { path: string; bytes: number; episodes: string[] }[];
  bytesFreed: number;
  torrentKept: boolean;
};

type LibraryFile = { id: number; path: string; size: number };

async function libraryFiles(ctx: ActionContext): Promise<LibraryFile[]> {
  const { target } = ctx;
  try {
    if (ctx.request.type === MediaType.MOVIE) {
      const server = getSettings().radarr.find((s) => s.id === target.serverId);
      if (!server) throw new Error('No Radarr server configured.');
      return await clients.radarr(server).getMovieFiles(target.externalId);
    }
    const server = getSettings().sonarr.find((s) => s.id === target.serverId);
    if (!server) throw new Error('No Sonarr server configured.');
    return await clients.sonarr(server).getEpisodeFiles(target.externalId);
  } catch (e) {
    throw new ServiceError(
      ctx.request.type === MediaType.MOVIE ? 'radarr' : 'sonarr',
      e instanceof Error ? e.message : String(e)
    );
  }
}

export async function getDeletePreview(
  request: MediaRequest,
  seasonNumber: number | null,
  episodeNumber: number | null
): Promise<DeletePreview> {
  const scope: Scope = { seasonNumber, episodeNumber };
  checkScopeShape(request, scope);
  const ctx = deleteContext(await loadContext(request, scope));
  const isMovie = request.type === MediaType.MOVIE;
  const library = await libraryFiles(ctx);
  const preview: DeletePreview = {
    files: [],
    bytesFreed: 0,
    torrentKept: ctx.torrents.some((p) => !p.covered),
  };
  const kept = ctx.torrents.filter((p) => !p.covered);

  if (isMovie) {
    for (const file of library) {
      preview.files.push({ path: file.path, bytes: file.size, episodes: [] });
      if (!kept.length) preview.bytesFreed += file.size;
    }
  } else {
    const byId = new Map(library.map((f) => [f.id, f]));
    const fileIds = [
      ...new Set(
        ctx.episodes
          .filter((e) => e.hasFile && e.episodeFileId)
          .map((e) => e.episodeFileId as number)
      ),
    ];
    for (const id of fileIds) {
      const covers = ctx.inputs.episodes.filter((e) => e.episodeFileId === id);
      const file = byId.get(id);
      const bytes = file?.size ?? covers[0]?.sizeOnDisk ?? 0;
      const hardlinked = kept.some((plan) =>
        covers.some(
          (e) =>
            plan.keyIndexes.has(episodeKey(e)) ||
            (plan.unmappedMedia &&
              e.id !== undefined &&
              plan.episodeIds.has(e.id))
        )
      );
      preview.files.push({
        path: file?.path ?? '',
        bytes,
        episodes: covers.map((e) => episodeLabel(episodeKey(e))),
      });
      if (!hardlinked) preview.bytesFreed += bytes;
    }
  }

  const byKey = new Map(ctx.inputs.episodes.map((e) => [episodeKey(e), e]));
  for (const plan of ctx.torrents) {
    if (!plan.covered) continue;
    const keysByIndex = new Map<number, string[]>();
    for (const [key, indexes] of mapFilesToEpisodes(plan.torrent.files)) {
      for (const index of indexes) {
        keysByIndex.set(index, [...(keysByIndex.get(index) ?? []), key]);
      }
    }
    const anyImported = isMovie
      ? library.length > 0
      : ctx.episodes.some(
          (e) => e.hasFile && e.id !== undefined && plan.episodeIds.has(e.id)
        );

    for (const file of plan.torrent.files) {
      if (file.bytesCompleted <= 0) continue;
      if (isExtraFile(file.name)) {
        preview.bytesFreed += file.bytesCompleted;
        continue;
      }
      const keys = keysByIndex.get(file.index) ?? [];
      const hasLibraryCopy = keys.length
        ? keys.some((key) => byKey.get(key)?.hasFile)
        : anyImported;
      if (hasLibraryCopy) continue;
      preview.bytesFreed += file.bytesCompleted;
      preview.files.push({
        path: file.name,
        bytes: file.bytesCompleted,
        episodes: keys.map(episodeLabel),
      });
    }
  }

  return preview;
}

export const previews = { getDeletePreview };
