import type { QueueRecord } from '@server/api/servarr/base';
import type { TorrentInfo } from '@server/api/transmission';
import type {
  ControlState,
  RequestItemControl,
} from '@server/entity/RequestItemControl';
import { mapFilesToEpisodes } from '@server/lib/requestControls/fileMap';
import { effectiveState } from '@server/lib/requestControls/store';
import type {
  ItemAction,
  ItemState,
  ItemStatus,
  RequestLiveState,
  SeasonState,
} from './types';

export type ItemInputs = {
  control: ControlState | null;
  hasFile: boolean;
  queue?: QueueRecord;
  torrent?: TorrentInfo;
  fileIndexes?: number[];
  searchRunning: boolean;
  lastSearchTime?: string;
  monitored: boolean;
};

export type RequestInputs = {
  requestId: number;
  type: 'movie' | 'tv';
  now: string;
  controls: RequestItemControl[];
  episodes: {
    id?: number;
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    monitored: boolean;
    hasFile: boolean;
    episodeFileId?: number;
    sizeOnDisk?: number;
    lastSearchTime?: string;
  }[];
  movie?: {
    id?: number;
    monitored: boolean;
    hasFile: boolean;
    sizeOnDisk?: number;
    lastSearchTime?: string;
  };
  queue: QueueRecord[];
  torrents: TorrentInfo[];
  runningSearches: {
    episodeIds?: number[];
    seriesId?: number;
    seasonNumber?: number;
    movieIds?: number[];
  }[];
  requestedSeasons: number[];
  failedSources: ('sonarr' | 'radarr' | 'transmission')[];
};

const PRIORITY: ItemStatus[] = [
  'downloading',
  'importing',
  'searching',
  'queued',
  'stalled',
  'failed',
  'not_found',
  'paused',
  'on_plex',
  'deleted',
  'unknown',
];

const selectedBytes = (t: TorrentInfo, indexes?: number[]) => {
  const files = indexes?.length
    ? t.files.filter((f) => indexes.includes(f.index))
    : [];
  return {
    done: files.reduce((s, f) => s + f.bytesCompleted, 0),
    total: files.reduce((s, f) => s + f.length, 0),
  };
};

export function deriveItemStatus(input: ItemInputs): ItemStatus {
  if (input.control === 'deleted') return 'deleted';
  if (input.hasFile) return 'on_plex';
  if (input.control === 'paused') return 'paused';

  const { queue, torrent } = input;
  if (
    queue?.trackedDownloadStatus === 'error' ||
    (torrent && torrent.error > 0)
  )
    return 'failed';
  if (
    queue &&
    ['importPending', 'importing'].includes(queue.trackedDownloadState)
  )
    return 'importing';

  if (torrent) {
    if (torrent.status === 3) return 'queued';
    if (torrent.status === 4) {
      const { done, total } = selectedBytes(torrent, input.fileIndexes);
      if (total > 0 && done === 0) return 'queued';
      if (torrent.rateDownload === 0 && torrent.peersSendingToUs === 0)
        return 'stalled';
      return 'downloading';
    }
  }

  if (input.searchRunning) return 'searching';
  if (input.monitored && input.lastSearchTime) return 'not_found';
  return 'unknown';
}

export function actionsFor(status: ItemStatus): ItemAction[] {
  switch (status) {
    case 'on_plex':
      return ['delete'];
    case 'paused':
      return ['resume', 'delete'];
    case 'deleted':
      return ['restore'];
    default:
      return ['prioritize', 'pause', 'delete'];
  }
}

export function mostActive(statuses: ItemStatus[]): ItemStatus {
  for (const s of PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return 'unknown';
}

type Built = {
  item: ItemState;
  hash?: string;
  weight: number;
  done: number;
  shared: boolean;
};

const WEIGHTED: ItemStatus[] = ['downloading', 'queued', 'paused', 'stalled'];

export function deriveRequestState(input: RequestInputs): RequestLiveState {
  const torrentByHash = new Map(
    input.torrents.map((t) => [t.hashString.toLowerCase(), t])
  );
  const fileMaps = new Map(
    input.torrents.map((t) => [t.hashString, mapFilesToEpisodes(t.files)])
  );

  const searchRunning = (
    episodeId: number | undefined,
    seasonNumber: number | null,
    movieId?: number
  ) =>
    input.runningSearches.some(
      (s) =>
        (episodeId !== undefined && s.episodeIds?.includes(episodeId)) ||
        (movieId !== undefined && s.movieIds?.includes(movieId)) ||
        (s.seriesId !== undefined &&
          !s.episodeIds &&
          (s.seasonNumber === undefined || s.seasonNumber === seasonNumber))
    );

  const build = (
    seasonNumber: number | null,
    episodeNumber: number | null,
    src: {
      id?: number;
      title?: string;
      monitored: boolean;
      hasFile: boolean;
      sizeOnDisk?: number;
      lastSearchTime?: string;
    },
    queueRecord: QueueRecord | undefined
  ): Built => {
    const control = effectiveState(input.controls, seasonNumber, episodeNumber);
    const key =
      seasonNumber !== null && episodeNumber !== null
        ? `${seasonNumber}x${episodeNumber}`
        : undefined;

    let torrent = queueRecord
      ? torrentByHash.get(queueRecord.downloadId.toLowerCase())
      : undefined;
    let fileIndexes: number[] | undefined;
    if (key) {
      if (torrent) {
        fileIndexes = fileMaps.get(torrent.hashString)?.get(key);
      } else {
        for (const t of input.torrents) {
          const idx = fileMaps.get(t.hashString)?.get(key);
          if (idx) {
            torrent = t;
            fileIndexes = idx;
            break;
          }
        }
      }
    }

    const status = deriveItemStatus({
      control,
      hasFile: src.hasFile,
      queue: queueRecord,
      torrent,
      fileIndexes,
      searchRunning: searchRunning(
        seasonNumber !== null ? src.id : undefined,
        seasonNumber,
        seasonNumber === null ? src.id : undefined
      ),
      lastSearchTime: src.lastSearchTime,
      monitored: src.monitored,
    });

    const item: ItemState = {
      seasonNumber,
      episodeNumber,
      status,
      actions: actionsFor(status),
    };
    if (src.title !== undefined) item.title = src.title;
    if (src.sizeOnDisk !== undefined) item.bytesOnDisk = src.sizeOnDisk;
    if (src.lastSearchTime) item.lastSearchedAt = src.lastSearchTime;

    let weight = 0;
    let done = 0;
    let shared = false;
    let hash: string | undefined;
    if (torrent && status !== 'on_plex' && status !== 'deleted') {
      hash = torrent.hashString;
      const bytes = selectedBytes(torrent, fileIndexes);
      if (bytes.total > 0) {
        item.percent = Math.round((bytes.done / bytes.total) * 100);
        weight = bytes.total;
        done = bytes.done;
      } else {
        item.percent = Math.round(torrent.percentDone * 100);
        weight = torrent.sizeWhenDone;
        done = torrent.percentDone * torrent.sizeWhenDone;
        shared = true;
      }
      if (torrent.eta > 0 && ['downloading', 'stalled'].includes(status)) {
        item.etaSeconds = torrent.eta;
      }
    }
    if (status === 'paused') {
      const paused = input.controls.find(
        (c) =>
          c.state === 'paused' &&
          c.seasonNumber === seasonNumber &&
          c.episodeNumber === episodeNumber
      );
      if (paused?.pausedAtPercent != null) {
        item.percent = paused.pausedAtPercent;
      }
    }
    if (queueRecord?.errorMessage && status === 'failed') {
      item.error = queueRecord.errorMessage;
    } else if (torrent && torrent.error > 0 && status === 'failed') {
      item.error = torrent.errorString;
    }
    return { item, hash, weight, done, shared };
  };

  const queueFor = (episodeId?: number, movieId?: number) =>
    input.queue.find(
      (q) =>
        (episodeId !== undefined && q.episodeId === episodeId) ||
        (movieId !== undefined && q.movieId === movieId)
    );

  const builtAll: Built[] = [];
  const seasons: SeasonState[] = [];
  let movie: ItemState | undefined;

  if (input.type === 'movie') {
    const src = input.movie ?? { monitored: false, hasFile: false };
    const b = build(null, null, src, queueFor(undefined, src.id) ?? undefined);
    movie = b.item;
    builtAll.push(b);
  } else {
    for (const seasonNumber of input.requestedSeasons) {
      const builts = input.episodes
        .filter((e) => e.seasonNumber === seasonNumber)
        .sort((a, b) => a.episodeNumber - b.episodeNumber)
        .map((e) =>
          build(seasonNumber, e.episodeNumber, e, queueFor(e.id, undefined))
        );
      builtAll.push(...builts);
      const status = builts.length
        ? mostActive(builts.map((b) => b.item.status))
        : 'unknown';
      const season: SeasonState = {
        seasonNumber,
        status,
        episodes: builts.map((b) => b.item),
        actions: actionsFor(status),
      };
      const hashes = new Set(
        builts.map((b) => b.hash).filter((h): h is string => !!h)
      );
      for (const t of input.torrents) {
        const m = fileMaps.get(t.hashString);
        if (m && [...m.keys()].some((k) => k.startsWith(`${seasonNumber}x`))) {
          hashes.add(t.hashString);
        }
      }
      const rel = input.torrents.find((t) => hashes.has(t.hashString));
      if (rel) {
        season.release = {
          name: rel.name,
          sizeBytes: rel.sizeWhenDone,
          peers: rel.peersConnected,
          rateBytes: rel.rateDownload,
        };
      }
      seasons.push(season);
    }
  }

  const items = builtAll.map((b) => b.item);
  const status = items.length
    ? mostActive(items.map((i) => i.status))
    : 'unknown';

  let totalWeight = 0;
  let totalDone = 0;
  const countedShared = new Set<string>();
  for (const b of builtAll) {
    if (!WEIGHTED.includes(b.item.status) || b.weight === 0) continue;
    if (b.shared && b.hash) {
      if (countedShared.has(b.hash)) continue;
      countedShared.add(b.hash);
    }
    totalWeight += b.weight;
    totalDone += b.done;
  }

  const summary: RequestLiveState['summary'] = {
    status,
    ready: items.filter((i) => i.status === 'on_plex').length,
    total: input.type === 'movie' ? 1 : items.length,
    paused: items.filter((i) => i.status === 'paused').length,
    deleted: items.filter((i) => i.status === 'deleted').length,
  };
  if (totalWeight > 0) {
    summary.percent = Math.round((totalDone / totalWeight) * 100);
  }
  const etas = items
    .map((i) => i.etaSeconds)
    .filter((e): e is number => e !== undefined);
  if (etas.length) summary.etaSeconds = Math.max(...etas);

  const state: RequestLiveState = {
    requestId: input.requestId,
    available: input.failedSources.length === 0,
    summary,
    seasons,
    actions: actionsFor(status),
    updatedAt: input.now,
  };
  if (movie) state.movie = movie;
  return state;
}
