import type { CommandResource, QueueRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TransmissionAPI, { type TorrentInfo } from '@server/api/transmission';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { getControls } from '@server/lib/requestControls/store';
import type {
  DVRSettings,
  RadarrSettings,
  SonarrSettings,
  TransmissionSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { RequestInputs } from './derive';

export type ServiceKind = 'sonarr' | 'radarr';

export type ServiceTarget = {
  kind: ServiceKind;
  serverId?: number;
  externalId: number;
};

type Source = RequestInputs['failedSources'][number];

const SEARCH_COMMANDS = [
  'EpisodeSearch',
  'SeasonSearch',
  'SeriesSearch',
  'MoviesSearch',
];

const TORRENT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

let transmissionClient: { key: string; api: TransmissionAPI } | undefined;

export const clients = {
  sonarr: (settings: SonarrSettings): SonarrAPI =>
    new SonarrAPI({
      apiKey: settings.apiKey,
      url: SonarrAPI.buildUrl(settings, '/api/v3'),
    }),
  radarr: (settings: RadarrSettings): RadarrAPI =>
    new RadarrAPI({
      apiKey: settings.apiKey,
      url: RadarrAPI.buildUrl(settings, '/api/v3'),
    }),
  transmission: (settings: TransmissionSettings): TransmissionAPI => {
    const key = JSON.stringify(settings);
    if (transmissionClient?.key !== key) {
      transmissionClient = { key, api: new TransmissionAPI(settings) };
    }
    return transmissionClient.api;
  },
};

export function serverFor<T extends DVRSettings>(
  servers: T[],
  request: Pick<MediaRequest, 'is4k' | 'serverId'>
): T | undefined {
  let server = servers.find((s) => s.isDefault && s.is4k === request.is4k);
  if (
    request.serverId !== null &&
    request.serverId !== undefined &&
    request.serverId >= 0 &&
    server?.id !== request.serverId
  ) {
    server = servers.find((s) => s.id === request.serverId);
  }
  return server;
}

export function serviceTarget(
  request: MediaRequest
): ServiceTarget | undefined {
  const externalId = request.is4k
    ? request.media?.externalServiceId4k
    : request.media?.externalServiceId;
  if (externalId === null || externalId === undefined) {
    return undefined;
  }
  const kind: ServiceKind =
    request.type === MediaType.MOVIE ? 'radarr' : 'sonarr';
  const settings = getSettings();
  const servers: DVRSettings[] =
    kind === 'radarr' ? settings.radarr : settings.sonarr;
  const mediaServiceId = request.is4k
    ? request.media?.serviceId4k
    : request.media?.serviceId;
  const server =
    (mediaServiceId !== null && mediaServiceId !== undefined
      ? servers.find((s) => s.id === mediaServiceId)
      : undefined) ?? serverFor(servers, request);
  return { kind, serverId: server?.id, externalId };
}

export type ServarrRound = {
  commands: Map<string, Promise<CommandResource[]>>;
};

export const newRound = (): ServarrRound => ({ commands: new Map() });

const roundCommands = (
  round: ServarrRound,
  key: string,
  load: () => Promise<CommandResource[]>
): Promise<CommandResource[]> => {
  let commands = round.commands.get(key);
  if (!commands) {
    commands = load();
    round.commands.set(key, commands);
  }
  return commands;
};

export function torrentHashes(queue: QueueRecord[]): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const { downloadId } of queue) {
    if (!downloadId || !TORRENT_HASH.test(downloadId)) continue;
    const key = downloadId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashes.push(downloadId);
  }
  return hashes;
}

export async function loadTorrents(hashes: string[]): Promise<TorrentInfo[]> {
  const settings = getSettings().transmission;
  if (!settings.enabled || hashes.length === 0) {
    return [];
  }
  return clients.transmission(settings).getTorrents(hashes);
}

export async function findRequest(
  requestId: number
): Promise<MediaRequest | null> {
  return getRepository(MediaRequest).findOne({ where: { id: requestId } });
}

const settle = async <T>(
  source: Source,
  failed: Set<Source>,
  requestId: number,
  fn: () => Promise<T>
): Promise<T | undefined> => {
  try {
    return await fn();
  } catch (e) {
    failed.add(source);
    logger.warn(`Failed to load ${source} data for live status`, {
      label: 'LiveStatus',
      requestId,
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
};

const searchBodies = (
  commands: CommandResource[] | undefined
): RequestInputs['runningSearches'] =>
  (commands ?? [])
    .filter(
      (c) =>
        (c.status === 'queued' || c.status === 'started') &&
        SEARCH_COMMANDS.includes(c.name)
    )
    .map((c) => c.body ?? {});

export async function loadRequestInputs(
  request: MediaRequest,
  round: ServarrRound = newRound()
): Promise<RequestInputs> {
  const type = request.type === MediaType.MOVIE ? 'movie' : 'tv';
  const inputs: RequestInputs = {
    requestId: request.id,
    type,
    now: new Date().toISOString(),
    controls: await getControls(request.id),
    episodes: [],
    queue: [],
    torrents: [],
    runningSearches: [],
    requestedSeasons:
      type === 'tv'
        ? [...new Set((request.seasons ?? []).map((s) => s.seasonNumber))].sort(
            (a, b) => a - b
          )
        : [],
    failedSources: [],
  };

  const target = serviceTarget(request);
  if (!target) {
    return inputs;
  }

  const failed = new Set<Source>();
  const settings = getSettings();
  const externalId = target.externalId;
  let queue: QueueRecord[] | undefined;

  if (target.kind === 'sonarr') {
    inputs.seriesId = externalId;
    const server = settings.sonarr.find((s) => s.id === target.serverId);
    if (!server) {
      failed.add('sonarr');
      logger.warn('No Sonarr server configured for request', {
        label: 'LiveStatus',
        requestId: request.id,
      });
    } else {
      const sonarr = clients.sonarr(server);
      const [episodes, files, records, commands] = await Promise.all([
        settle('sonarr', failed, request.id, () =>
          sonarr.getEpisodes(externalId)
        ),
        settle('sonarr', failed, request.id, () =>
          sonarr.getEpisodeFiles(externalId)
        ),
        settle('sonarr', failed, request.id, () =>
          sonarr.getQueueFor({ seriesId: externalId })
        ),
        settle('sonarr', failed, request.id, () =>
          roundCommands(round, `sonarr:${server.id}`, () =>
            sonarr.getCommands()
          )
        ),
      ]);
      const sizes = new Map((files ?? []).map((f) => [f.id, f.size]));
      const seasons = new Set(inputs.requestedSeasons);
      inputs.episodes = (episodes ?? [])
        .filter((e) => seasons.has(e.seasonNumber))
        .map((e) => {
          const episode: RequestInputs['episodes'][number] = {
            id: e.id,
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
            title: e.title,
            monitored: e.monitored,
            hasFile: e.hasFile,
          };
          if (e.episodeFileId) {
            episode.episodeFileId = e.episodeFileId;
            const size = sizes.get(e.episodeFileId);
            if (size !== undefined) episode.sizeOnDisk = size;
          }
          if (e.lastSearchTime) episode.lastSearchTime = e.lastSearchTime;
          return episode;
        });
      queue = records;
      inputs.runningSearches = searchBodies(commands);
    }
  } else {
    inputs.movieId = externalId;
    const server = settings.radarr.find((s) => s.id === target.serverId);
    if (!server) {
      failed.add('radarr');
      logger.warn('No Radarr server configured for request', {
        label: 'LiveStatus',
        requestId: request.id,
      });
    } else {
      const radarr = clients.radarr(server);
      const [movie, files, records, commands] = await Promise.all([
        settle('radarr', failed, request.id, () =>
          radarr.getMovie({ id: externalId })
        ),
        settle('radarr', failed, request.id, () =>
          radarr.getMovieFiles(externalId)
        ),
        settle('radarr', failed, request.id, () =>
          radarr.getQueueFor({ movieId: externalId })
        ),
        settle('radarr', failed, request.id, () =>
          roundCommands(round, `radarr:${server.id}`, () =>
            radarr.getCommands()
          )
        ),
      ]);
      if (movie) {
        inputs.movie = { monitored: movie.monitored, hasFile: movie.hasFile };
        if (files?.length) {
          inputs.movie.sizeOnDisk = files.reduce((s, f) => s + f.size, 0);
        } else if (movie.movieFile?.size !== undefined) {
          inputs.movie.sizeOnDisk = movie.movieFile.size;
        }
        if (movie.lastSearchTime) {
          inputs.movie.lastSearchTime = movie.lastSearchTime;
        }
      }
      queue = records;
      inputs.runningSearches = searchBodies(commands);
    }
  }

  inputs.queue = queue ?? [];

  const hashes = torrentHashes(inputs.queue);
  if (settings.transmission.enabled && hashes.length) {
    const torrents = await settle('transmission', failed, request.id, () =>
      loadTorrents(hashes)
    );
    inputs.torrents = torrents ?? [];
  }

  inputs.failedSources = [...failed];
  return inputs;
}

export const sources = {
  findRequest,
  loadRequestInputs,
  loadTorrents,
  serviceTarget,
};
