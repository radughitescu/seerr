import type { HistoryRecord, QueueRecord } from '@server/api/servarr/base';
import type RadarrAPI from '@server/api/servarr/radarr';
import type SonarrAPI from '@server/api/servarr/sonarr';
import type TransmissionAPI from '@server/api/transmission';
import type { TorrentInfo } from '@server/api/transmission';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestItemControl } from '@server/entity/RequestItemControl';
import type { User } from '@server/entity/User';
import {
  deriveRequestState,
  type RequestInputs,
} from '@server/lib/liveStatus/derive';
import { liveStatusHub } from '@server/lib/liveStatus/hub';
import {
  clients,
  loadRequestInputs,
  loadTorrents,
  serviceTarget,
  torrentHashes,
  type ServiceTarget,
} from '@server/lib/liveStatus/sources';
import type {
  ItemAction,
  ItemState,
  RequestLiveState,
} from '@server/lib/liveStatus/types';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isExtraFile, mapFilesToEpisodes } from './fileMap';
import {
  effectiveState,
  getControls,
  releaseControl,
  setControl,
  type ControlLayout,
  type ItemKey,
} from './store';

export type ServiceName = 'sonarr' | 'radarr' | 'transmission';

const SERVICE_LABEL: Record<ServiceName, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  transmission: 'Transmission',
};

export class ServiceError extends Error {
  public readonly service: ServiceName;

  constructor(service: ServiceName, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.service = service;
  }
}

export class ActionError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
  }
}

export type ActionRequest = {
  request: MediaRequest;
  action: ItemAction;
  seasonNumber: number | null;
  episodeNumber: number | null;
  user: User;
};

export type Scope = {
  seasonNumber: number | null;
  episodeNumber: number | null;
};

export type Episode = RequestInputs['episodes'][number];

export type TorrentPlan = {
  torrent: TorrentInfo;
  covered: boolean;
  unmappedMedia: boolean;
  fileIndexes: number[];
  keyIndexes: Map<string, number[]>;
  episodeIds: Set<number>;
  queueIds: number[];
};

export type DownloadLinks = {
  byHash: Map<string, Set<number>>;
  unattributed: Set<string>;
  hashes: Map<string, string>;
};

export type ActionContext = {
  request: MediaRequest;
  scope: Scope;
  target: ServiceTarget;
  inputs: RequestInputs;
  state: RequestLiveState;
  known: TorrentInfo[];
  links: DownloadLinks;
  base: Episode[];
  episodes: Episode[];
  torrents: TorrentPlan[];
};

export const episodeKey = (e: {
  seasonNumber: number;
  episodeNumber: number;
}) => `${e.seasonNumber}x${e.episodeNumber}`;

export const episodeLabel = (key: string) => {
  const [s, e] = key.split('x').map(Number);
  return `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
};

const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

async function call<T>(service: ServiceName, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    const cause = (e as { cause?: unknown })?.cause;
    const detail = cause ? `${errorMessage(e)}: ${errorMessage(cause)}` : '';
    throw new ServiceError(service, detail || errorMessage(e));
  }
}

const isTv = (request: MediaRequest) => request.type !== MediaType.MOVIE;

const CONTROLLABLE = [
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.COMPLETED,
];

export function assertControllable(request: MediaRequest): void {
  if (!CONTROLLABLE.includes(request.status)) {
    throw new ActionError(409, 'Only approved requests can be controlled.');
  }
}

export function checkScopeShape(request: MediaRequest, scope: Scope): void {
  const valid = (n: number | null) =>
    n === null || (Number.isInteger(n) && n >= 0);
  if (!valid(scope.seasonNumber) || !valid(scope.episodeNumber)) {
    throw new ActionError(400, 'Invalid season or episode number.');
  }
  if (scope.episodeNumber !== null && scope.seasonNumber === null) {
    throw new ActionError(400, 'An episode needs a season number.');
  }
  if (!isTv(request) && scope.seasonNumber !== null) {
    throw new ActionError(400, 'Movies have no seasons.');
  }
}

function sonarrFor(target: ServiceTarget): SonarrAPI {
  const server = getSettings().sonarr.find((s) => s.id === target.serverId);
  if (!server) {
    throw new ServiceError('sonarr', 'No Sonarr server configured.');
  }
  return clients.sonarr(server);
}

function radarrFor(target: ServiceTarget): RadarrAPI {
  const server = getSettings().radarr.find((s) => s.id === target.serverId);
  if (!server) {
    throw new ServiceError('radarr', 'No Radarr server configured.');
  }
  return clients.radarr(server);
}

const transmission = (): TransmissionAPI =>
  clients.transmission(getSettings().transmission);

const HISTORY_EVENTS = new Set(['grabbed', 'downloadFolderImported']);

const isTorrentHash = (downloadId?: string) =>
  !!downloadId && torrentHashes([{ downloadId } as QueueRecord]).length > 0;

const sortEpisodes = (episodes: Episode[]) =>
  [...episodes].sort(
    (a, b) =>
      a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
  );

export function scopedEpisodes(inputs: RequestInputs, scope: Scope): Episode[] {
  return sortEpisodes(
    inputs.episodes.filter(
      (e) =>
        (scope.seasonNumber === null ||
          e.seasonNumber === scope.seasonNumber) &&
        (scope.episodeNumber === null ||
          e.episodeNumber === scope.episodeNumber)
    )
  );
}

export function linkDownloads(
  inputs: RequestInputs,
  history: HistoryRecord[]
): DownloadLinks {
  const links: DownloadLinks = {
    byHash: new Map(),
    unattributed: new Set(),
    hashes: new Map(),
  };
  const add = (downloadId: string, id: number | undefined) => {
    const hash = downloadId.toLowerCase();
    if (!links.hashes.has(hash)) links.hashes.set(hash, downloadId);
    const set = links.byHash.get(hash) ?? new Set<number>();
    links.byHash.set(hash, set);
    if (id === undefined) {
      links.unattributed.add(hash);
    } else {
      set.add(id);
    }
  };
  const movie = inputs.type === 'movie';
  for (const q of inputs.queue) {
    if (isTorrentHash(q.downloadId)) {
      add(q.downloadId, movie ? q.movieId : q.episodeId);
    }
  }
  for (const h of history) {
    if (!HISTORY_EVENTS.has(h.eventType) || !isTorrentHash(h.downloadId)) {
      continue;
    }
    add(h.downloadId as string, movie ? h.movieId : h.episodeId);
  }
  return links;
}

const recordsFor = (queue: QueueRecord[], hash: string) =>
  queue.filter((q) => q.downloadId?.toLowerCase() === hash.toLowerCase());

export function planTorrents(
  ctx: Pick<ActionContext, 'inputs' | 'known' | 'links'>,
  episodes: Episode[]
): TorrentPlan[] {
  const ids = new Set(
    episodes.map((e) => e.id).filter((id): id is number => id !== undefined)
  );
  const keys = new Set(episodes.map(episodeKey));
  const plans: TorrentPlan[] = [];

  for (const torrent of ctx.known) {
    const hash = torrent.hashString.toLowerCase();
    const queueIds = unique(
      recordsFor(ctx.inputs.queue, hash).map((r) => r.id)
    );

    if (ctx.inputs.type === 'movie') {
      const media = torrent.files.filter((f) => !isExtraFile(f.name));
      const covered = media.length === 1;
      plans.push({
        torrent,
        covered,
        unmappedMedia: !covered,
        fileIndexes: covered ? torrent.files.map((f) => f.index) : [],
        keyIndexes: new Map(),
        episodeIds: new Set(),
        queueIds,
      });
      continue;
    }

    const linked = ctx.links.byHash.get(hash) ?? new Set<number>();
    const map = mapFilesToEpisodes(torrent.files);
    const keyIndexes = new Map([...map].filter(([key]) => keys.has(key)));
    const episodeIds = new Set<number>();
    for (const e of episodes) {
      if (e.id === undefined) continue;
      if (keyIndexes.has(episodeKey(e)) || linked.has(e.id)) {
        episodeIds.add(e.id);
      }
    }
    if (episodeIds.size === 0) continue;

    const mapped = new Set([...map.values()].flat());
    const unmappedMedia = torrent.files.some(
      (f) => !mapped.has(f.index) && !isExtraFile(f.name)
    );
    const linkedInScope =
      linked.size > 0 && [...linked].every((id) => ids.has(id));
    const covered =
      !ctx.links.unattributed.has(hash) &&
      [...map.keys()].every((key) => keys.has(key)) &&
      (linked.size > 0 ? linkedInScope : !unmappedMedia);

    plans.push({
      torrent,
      covered,
      unmappedMedia,
      fileIndexes: unique([...keyIndexes.values()].flat()),
      keyIndexes,
      episodeIds,
      queueIds,
    });
  }

  return plans;
}

export function expandByFiles(
  inputs: RequestInputs,
  known: TorrentInfo[],
  episodes: Episode[]
): Episode[] {
  const byKey = new Map(inputs.episodes.map((e) => [episodeKey(e), e]));
  const result = new Map(episodes.map((e) => [episodeKey(e), e]));
  const groups: { keys: string[]; library: boolean }[] = [];

  const byFile = new Map<number, string[]>();
  for (const e of inputs.episodes) {
    if (!e.hasFile || !e.episodeFileId) continue;
    byFile.set(e.episodeFileId, [
      ...(byFile.get(e.episodeFileId) ?? []),
      episodeKey(e),
    ]);
  }
  groups.push(...[...byFile.values()].map((keys) => ({ keys, library: true })));

  const tracked = known.filter(
    (t) => recordsFor(inputs.queue, t.hashString).length > 0
  );
  for (const torrent of tracked) {
    const byIndex = new Map<number, string[]>();
    for (const [key, indexes] of mapFilesToEpisodes(torrent.files)) {
      for (const index of indexes) {
        byIndex.set(index, [...(byIndex.get(index) ?? []), key]);
      }
    }
    groups.push(
      ...[...byIndex.values()].map((keys) => ({ keys, library: false }))
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (!group.keys.some((key) => result.has(key))) continue;
      for (const key of group.keys) {
        const episode = byKey.get(key);
        if (
          episode &&
          !result.has(key) &&
          (group.library || !episode.hasFile)
        ) {
          result.set(key, episode);
          changed = true;
        }
      }
    }
  }

  return sortEpisodes([...result.values()]);
}

export function withEpisodes(
  ctx: ActionContext,
  episodes: Episode[]
): ActionContext {
  return { ...ctx, episodes, torrents: planTorrents(ctx, episodes) };
}

export function expanded(ctx: ActionContext): ActionContext {
  if (!isTv(ctx.request)) return ctx;
  return withEpisodes(ctx, expandByFiles(ctx.inputs, ctx.known, ctx.base));
}

export const deleteContext = expanded;

async function loadHistory(
  request: MediaRequest,
  target: ServiceTarget
): Promise<HistoryRecord[]> {
  const id = target.externalId;
  if (isTv(request)) {
    return call('sonarr', () => sonarrFor(target).getSeriesHistory(id));
  }
  return call('radarr', () => radarrFor(target).getMovieHistory(id));
}

export async function loadContext(
  request: MediaRequest,
  scope: Scope
): Promise<ActionContext> {
  const target = serviceTarget(request);
  if (!target) {
    throw new ActionError(
      400,
      'This request has not been added to Sonarr or Radarr yet.'
    );
  }
  const inputs = await loadRequestInputs(request);
  const fatal = inputs.failedSources.find((s) => s !== 'transmission');
  if (fatal) {
    throw new ServiceError(fatal, `${SERVICE_LABEL[fatal]} is unavailable.`);
  }
  if (
    scope.seasonNumber !== null &&
    !inputs.requestedSeasons.includes(scope.seasonNumber)
  ) {
    throw new ActionError(400, 'This season is not part of the request.');
  }
  const base = isTv(request) ? scopedEpisodes(inputs, scope) : [];
  if (scope.episodeNumber !== null && base.length === 0) {
    throw new ActionError(400, 'This episode is not part of the request.');
  }

  const links = linkDownloads(inputs, await loadHistory(request, target));
  const known = [...inputs.torrents];
  let transmissionDown = inputs.failedSources.includes('transmission');
  const loaded = new Set(known.map((t) => t.hashString.toLowerCase()));
  const queued = new Set(
    inputs.queue
      .map((q) => q.downloadId?.toLowerCase())
      .filter((h): h is string => !!h)
  );
  const extra = [...links.hashes]
    .filter(([hash]) => !loaded.has(hash) && !queued.has(hash))
    .map(([, original]) => original);
  if (!transmissionDown && extra.length && getSettings().transmission.enabled) {
    try {
      known.push(...(await loadTorrents(extra)));
    } catch (e) {
      logger.warn('Failed to load torrents from history for request control', {
        label: 'Request Controls',
        requestId: request.id,
        errorMessage: errorMessage(e),
      });
      transmissionDown = true;
    }
  }

  if (transmissionDown) {
    const ids = new Set(idsOf(base));
    const needed = isTv(request)
      ? links.unattributed.size > 0 ||
        [...links.byHash.values()].some((set) =>
          [...set].some((id) => ids.has(id))
        )
      : links.hashes.size > 0;
    if (needed) {
      throw new ServiceError('transmission', 'Transmission is unavailable.');
    }
  }

  const ctx: ActionContext = {
    request,
    scope,
    target,
    inputs,
    state: deriveRequestState(inputs),
    known,
    links,
    base,
    episodes: base,
    torrents: [],
  };
  return withEpisodes(ctx, base);
}

function scopeItem(
  state: RequestLiveState,
  scope: Scope
): { actions: ItemAction[]; percent?: number } | undefined {
  if (state.movie) {
    return state.movie;
  }
  if (scope.seasonNumber === null) {
    return { actions: state.actions, percent: state.summary.percent };
  }
  const season = state.seasons.find(
    (s) => s.seasonNumber === scope.seasonNumber
  );
  if (!season) return undefined;
  if (scope.episodeNumber !== null) {
    return season.episodes.find((e) => e.episodeNumber === scope.episodeNumber);
  }
  const percents = season.episodes
    .filter((e: ItemState) => e.status !== 'on_plex')
    .map((e) => e.percent)
    .filter((p): p is number => p !== undefined);
  return {
    actions: season.actions,
    percent: percents.length
      ? Math.round(percents.reduce((s, p) => s + p, 0) / percents.length)
      : undefined,
  };
}

const withinScope = (c: RequestItemControl, scope: Scope) =>
  scope.seasonNumber === null ||
  (c.seasonNumber === scope.seasonNumber &&
    (scope.episodeNumber === null || c.episodeNumber === scope.episodeNumber));

export function alreadyDone(
  action: ItemAction,
  controls: RequestItemControl[],
  scope: Scope
): boolean {
  const current = effectiveState(
    controls,
    scope.seasonNumber,
    scope.episodeNumber
  );
  switch (action) {
    case 'pause':
      return current === 'paused';
    case 'delete':
      return current === 'deleted';
    case 'resume':
      return (
        current === null &&
        !controls.some((c) => c.state === 'paused' && withinScope(c, scope))
      );
    case 'restore':
      return (
        current === null &&
        !controls.some((c) => c.state === 'deleted' && withinScope(c, scope))
      );
    default:
      return false;
  }
}

const idsOf = (episodes: Episode[]) =>
  episodes.map((e) => e.id).filter((id): id is number => id !== undefined);

const controlOf = (ctx: ActionContext, e: Episode) =>
  effectiveState(ctx.inputs.controls, e.seasonNumber, e.episodeNumber);

const notDeleted = (ctx: ActionContext) =>
  ctx.episodes.filter((e) => !e.hasFile && controlOf(ctx, e) !== 'deleted');

const uncontrolled = (ctx: ActionContext) =>
  ctx.episodes.filter((e) => !e.hasFile && controlOf(ctx, e) === null);

const holding = (ctx: ActionContext, targets: Episode[]) =>
  isTv(ctx.request)
    ? ctx.torrents.filter((p) =>
        targets.some((e) => e.id !== undefined && p.episodeIds.has(e.id))
      )
    : ctx.torrents;

const indexesFor = (
  ctx: ActionContext,
  plan: TorrentPlan,
  episodes: Episode[]
) =>
  isTv(ctx.request)
    ? unique(episodes.flatMap((e) => plan.keyIndexes.get(episodeKey(e)) ?? []))
    : plan.fileIndexes;

const wanted = (plan: TorrentPlan, indexes: number[], value: boolean) =>
  indexes.filter((i) => (plan.torrent.fileStats[i]?.wanted ?? true) === value);

async function setMonitored(
  ctx: ActionContext,
  episodes: Episode[],
  monitored: boolean
): Promise<void> {
  if (!isTv(ctx.request)) {
    const movieId = ctx.target.externalId;
    await call('radarr', () =>
      radarrFor(ctx.target).setMovieMonitored(movieId, monitored)
    );
    return;
  }
  const ids = idsOf(episodes);
  if (ids.length) {
    await call('sonarr', () =>
      sonarrFor(ctx.target).setEpisodesMonitored(ids, monitored)
    );
  }
}

const queuedElsewhere = (q: QueueRecord) =>
  !getSettings().transmission.enabled || !isTorrentHash(q.downloadId);

function movieNeedsSearch(ctx: ActionContext): boolean {
  return (
    !ctx.inputs.movie?.hasFile &&
    !ctx.torrents.some((p) => p.queueIds.length > 0) &&
    !ctx.inputs.queue.some(queuedElsewhere)
  );
}

async function search(ctx: ActionContext, targets: Episode[]): Promise<void> {
  if (!isTv(ctx.request)) {
    if (movieNeedsSearch(ctx)) {
      const movieId = ctx.target.externalId;
      await call('radarr', () => radarrFor(ctx.target).searchMovie(movieId));
    }
    return;
  }
  const missing = targets.filter(
    (e) =>
      e.id !== undefined &&
      !ctx.torrents.some(
        (p) => p.queueIds.length > 0 && p.episodeIds.has(e.id as number)
      ) &&
      !ctx.inputs.queue.some((q) => q.episodeId === e.id && queuedElsewhere(q))
  );
  if (!missing.length) return;
  const seriesId = ctx.target.externalId;
  const episodeIds: number[] = [];
  for (const seasonNumber of unique(missing.map((e) => e.seasonNumber))) {
    const inSeason = missing.filter((e) => e.seasonNumber === seasonNumber);
    const all = ctx.inputs.episodes.filter(
      (e) => e.seasonNumber === seasonNumber
    );
    if (
      ctx.scope.episodeNumber === null &&
      inSeason.length === all.length &&
      all.every((e) => !e.hasFile)
    ) {
      await call('sonarr', () =>
        sonarrFor(ctx.target).searchSeason(seriesId, seasonNumber)
      );
    } else {
      episodeIds.push(...idsOf(inSeason));
    }
  }
  if (episodeIds.length) {
    await call('sonarr', () =>
      sonarrFor(ctx.target).searchEpisodes(episodeIds)
    );
  }
}

async function rewant(ctx: ActionContext, targets: Episode[]): Promise<void> {
  const start: string[] = [];
  for (const plan of holding(ctx, targets)) {
    const hash = plan.torrent.hashString;
    const indexes = wanted(plan, indexesFor(ctx, plan, targets), false);
    if (indexes.length) {
      await call('transmission', () =>
        transmission().setFilesWanted(hash, indexes, true)
      );
    }
    if (plan.covered && plan.torrent.status === 0) {
      start.push(hash);
    }
  }
  if (start.length) {
    await call('transmission', () => transmission().start(start));
  }
}

const itemKey = (ctx: ActionContext): ItemKey => ({
  requestId: ctx.request.id,
  seasonNumber: ctx.scope.seasonNumber,
  episodeNumber: ctx.scope.episodeNumber,
});

const extraKeys = (
  ctx: ActionContext,
  include: (e: Episode) => boolean = () => true
): ItemKey[] => {
  const original = new Set(ctx.base.map(episodeKey));
  return ctx.episodes
    .filter((e) => !original.has(episodeKey(e)) && include(e))
    .map((e) => ({
      requestId: ctx.request.id,
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
    }));
};

const layoutOf = (inputs: RequestInputs): ControlLayout =>
  inputs.requestedSeasons.map((seasonNumber) => ({
    seasonNumber,
    episodeNumbers: inputs.episodes
      .filter((e) => e.seasonNumber === seasonNumber)
      .map((e) => e.episodeNumber),
  }));

async function prioritize(ctx: ActionContext): Promise<void> {
  const targets = uncontrolled(ctx);
  const plans = holding(ctx, targets);
  const hashes = plans.map((p) => p.torrent.hashString);
  if (hashes.length) {
    await call('transmission', () => transmission().queueMoveTop(hashes));
    await call('transmission', () =>
      transmission().setBandwidthPriorityHigh(hashes)
    );
  }
  for (const plan of plans) {
    if (plan.covered) continue;
    const indexes = indexesFor(ctx, plan, targets);
    if (indexes.length) {
      await call('transmission', () =>
        transmission().setFilePriorityHigh(plan.torrent.hashString, indexes)
      );
    }
  }
  await search(ctx, targets);
}

async function pause(ctx: ActionContext, user: User, percent?: number) {
  const targets = notDeleted(ctx);
  await setMonitored(ctx, targets, false);

  const stop: string[] = [];
  for (const plan of holding(ctx, targets)) {
    const hash = plan.torrent.hashString;
    if (plan.covered) {
      if (plan.torrent.status !== 0) stop.push(hash);
      continue;
    }
    const indexes = wanted(plan, indexesFor(ctx, plan, targets), true);
    if (indexes.length) {
      await call('transmission', () =>
        transmission().setFilesWanted(hash, indexes, false)
      );
    }
  }
  if (stop.length) {
    await call('transmission', () => transmission().stop(stop));
  }

  await setControl(itemKey(ctx), 'paused', user.id, percent);
  const pausable = (e: Episode) =>
    !e.hasFile && controlOf(ctx, e) !== 'deleted';
  for (const key of extraKeys(ctx, pausable)) {
    await setControl(key, 'paused', user.id, percent);
  }
}

async function resume(ctx: ActionContext) {
  const targets = notDeleted(ctx);
  await setMonitored(ctx, targets, true);
  await rewant(ctx, targets);
  await search(ctx, targets);
  const layout = layoutOf(ctx.inputs);
  await releaseControl(itemKey(ctx), layout, { keepDeleted: true });
  for (const key of extraKeys(ctx, (e) => controlOf(ctx, e) !== 'deleted')) {
    await releaseControl(key, layout, { keepDeleted: true });
  }
}

async function restore(ctx: ActionContext) {
  const pending = ctx.episodes.filter((e) => !e.hasFile);
  await setMonitored(ctx, ctx.episodes, true);
  await rewant(ctx, pending);
  await search(ctx, pending);
  await releaseControl(itemKey(ctx), layoutOf(ctx.inputs));
}

async function remove(ctx: ActionContext, user: User) {
  const movieFiles = isTv(ctx.request)
    ? []
    : await call('radarr', () =>
        radarrFor(ctx.target).getMovieFiles(ctx.target.externalId)
      );

  await setMonitored(ctx, ctx.episodes, false);

  const removeFromTransmission: string[] = [];
  for (const plan of ctx.torrents) {
    const hash = plan.torrent.hashString;
    if (plan.covered) {
      if (plan.queueIds.length) {
        const ids = plan.queueIds;
        if (isTv(ctx.request)) {
          await call('sonarr', () =>
            sonarrFor(ctx.target).removeQueueItems(ids, true)
          );
        } else {
          await call('radarr', () =>
            radarrFor(ctx.target).removeQueueItems(ids, true)
          );
        }
      } else {
        removeFromTransmission.push(hash);
      }
      continue;
    }
    const indexes = wanted(plan, plan.fileIndexes, true);
    if (indexes.length) {
      await call('transmission', () =>
        transmission().setFilesWanted(hash, indexes, false)
      );
    }
  }
  if (removeFromTransmission.length) {
    await call('transmission', () =>
      transmission().remove(removeFromTransmission, true)
    );
  }

  if (isTv(ctx.request)) {
    const fileIds = unique(
      ctx.episodes
        .filter((e) => e.hasFile && e.episodeFileId)
        .map((e) => e.episodeFileId as number)
    );
    if (fileIds.length) {
      await call('sonarr', () =>
        sonarrFor(ctx.target).deleteEpisodeFiles(fileIds)
      );
    }
  } else {
    for (const file of movieFiles) {
      await call('radarr', () =>
        radarrFor(ctx.target).deleteMovieFile(file.id)
      );
    }
  }

  await setControl(itemKey(ctx), 'deleted', user.id);
  for (const key of extraKeys(ctx)) {
    await setControl(key, 'deleted', user.id);
  }
}

const locks = new Map<string, Promise<void>>();

const lockKey = (requestId: number, scope: Scope) =>
  `${requestId}:${scope.seasonNumber ?? '*'}:${scope.episodeNumber ?? '*'}`;

const overlaps = (a: string, b: string) => {
  const [requestA, seasonA] = a.split(':');
  const [requestB, seasonB] = b.split(':');
  return (
    requestA === requestB &&
    (seasonA === '*' || seasonB === '*' || seasonA === seasonB)
  );
};

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    const blockers = [...locks]
      .filter(([held]) => overlaps(held, key))
      .map(([, promise]) => promise);
    if (!blockers.length) break;
    await Promise.all(blockers);
  }
  let release: () => void = () => undefined;
  locks.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

async function currentState(request: MediaRequest): Promise<RequestLiveState> {
  return (
    liveStatusHub.cachedState(request.id) ??
    deriveRequestState(await loadRequestInputs(request))
  );
}

export async function runAction(req: ActionRequest): Promise<RequestLiveState> {
  const { request, action, user } = req;
  const scope: Scope = {
    seasonNumber: req.seasonNumber,
    episodeNumber: req.episodeNumber,
  };
  assertControllable(request);
  checkScopeShape(request, scope);

  return withLock(lockKey(request.id, scope), async () => {
    if (alreadyDone(action, await getControls(request.id), scope)) {
      return currentState(request);
    }

    const loaded = await loadContext(request, scope);
    const item = scopeItem(loaded.state, scope);
    if (!item || !item.actions.includes(action)) {
      throw new ActionError(
        400,
        `Cannot ${action} this item in its current state.`
      );
    }
    const ctx = action === 'restore' ? loaded : expanded(loaded);

    logger.info('Running request control action', {
      label: 'Request Controls',
      requestId: request.id,
      action,
      seasonNumber: scope.seasonNumber,
      episodeNumber: scope.episodeNumber,
      userId: user.id,
    });

    switch (action) {
      case 'prioritize':
        await prioritize(ctx);
        break;
      case 'pause':
        await pause(ctx, user, item.percent);
        break;
      case 'resume':
        await resume(ctx);
        break;
      case 'delete':
        await remove(ctx, user);
        break;
      case 'restore':
        await restore(ctx);
        break;
    }

    await liveStatusHub.refresh(request.id);

    return (
      liveStatusHub.cachedState(request.id) ??
      deriveRequestState({
        ...ctx.inputs,
        now: new Date().toISOString(),
        controls: await getControls(request.id),
      })
    );
  });
}

export const actions = { runAction };
