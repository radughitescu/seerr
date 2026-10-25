import type {
  ItemAction,
  ItemState,
  RequestLiveState,
} from '@server/lib/liveStatus/types';
import type { DeletePreview } from '@server/lib/requestControls/preview';

export type Scope = { seasonNumber?: number; episodeNumber?: number };

export type EpisodeGroup =
  | { kind: 'single'; item: ItemState }
  | { kind: 'group'; key: string; items: ItemState[] };

const sameActions = (a: ItemAction[], b: ItemAction[]): boolean =>
  a.length === b.length && a.every((action, i) => action === b[i]);

const collapsible = (item: ItemState): boolean =>
  item.percent === undefined &&
  item.error === undefined &&
  item.episodeNumber !== null;

export function groupEpisodes(items: ItemState[]): EpisodeGroup[] {
  const out: EpisodeGroup[] = [];
  let run: ItemState[] = [];

  const flush = () => {
    if (run.length >= 2) {
      out.push({
        kind: 'group',
        key: `${run[0].episodeNumber}-${run[run.length - 1].episodeNumber}`,
        items: run,
      });
    } else {
      run.forEach((item) => out.push({ kind: 'single', item }));
    }
    run = [];
  };

  for (const item of items) {
    const prev = run[run.length - 1];
    if (
      prev &&
      collapsible(item) &&
      prev.status === item.status &&
      sameActions(prev.actions, item.actions) &&
      (item.episodeNumber ?? 0) === (prev.episodeNumber ?? 0) + 1
    ) {
      run.push(item);
      continue;
    }
    flush();
    if (collapsible(item)) {
      run.push(item);
    } else {
      out.push({ kind: 'single', item });
    }
  }
  flush();
  return out;
}

const pad = (n: number | null): string => String(n ?? 0).padStart(2, '0');

export const episodeLabel = (episodeNumber: number | null): string =>
  `E${pad(episodeNumber)}`;

export const episodeRangeLabel = (items: ItemState[]): string =>
  items.length > 1
    ? `E${pad(items[0].episodeNumber)}–${pad(
        items[items.length - 1].episodeNumber
      )}`
    : episodeLabel(items[0]?.episodeNumber ?? null);

export const sharedActions = (items: ItemState[]): ItemAction[] =>
  items.length
    ? items[0].actions.filter((a) => items.every((i) => i.actions.includes(a)))
    : [];

export const latestSearch = (items: ItemState[]): string | undefined =>
  items
    .map((i) => i.lastSearchedAt)
    .filter((t): t is string => !!t)
    .sort()
    .pop();

export const allItems = (state: RequestLiveState): ItemState[] =>
  state.movie ? [state.movie] : state.seasons.flatMap((s) => s.episodes);

export type BulkControl = 'resume' | 'pause' | null;

export function bulkControl(state: RequestLiveState): BulkControl {
  const pending = allItems(state).filter((i) => i.status !== 'on_plex');
  if (
    state.summary.status === 'paused' ||
    (pending.length > 0 && pending.every((i) => i.status === 'paused'))
  ) {
    return 'resume';
  }
  return state.actions.includes('pause') ? 'pause' : null;
}

export type SummaryParts = {
  percent?: number;
  ready?: { ready: number; total: number };
  paused?: number;
  deleted?: number;
  etaSeconds?: number;
};

export function summaryParts(
  summary: RequestLiveState['summary'],
  isMovie: boolean
): SummaryParts {
  const parts: SummaryParts = {};
  if (summary.percent !== undefined && summary.status !== 'on_plex') {
    parts.percent = summary.percent;
  }
  if (!isMovie && summary.ready > 0) {
    parts.ready = { ready: summary.ready, total: summary.total };
  }
  if (!isMovie && summary.paused > 0) parts.paused = summary.paused;
  if (!isMovie && summary.deleted > 0) parts.deleted = summary.deleted;
  if (summary.etaSeconds !== undefined && summary.etaSeconds > 0) {
    parts.etaSeconds = summary.etaSeconds;
  }
  return parts;
}

export type EtaParts =
  | { unit: 'lessThanMinute' }
  | { unit: 'minutes'; minutes: number }
  | { unit: 'hours'; hours: number; minutes: number };

export function etaParts(seconds: number): EtaParts {
  if (seconds < 60) return { unit: 'lessThanMinute' };
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return { unit: 'minutes', minutes: totalMinutes };
  return {
    unit: 'hours',
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(
  iso: string,
  nowMs: number
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const diff = Math.round((new Date(iso).getTime() - nowMs) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= size) {
      return { value: Math.round(diff / size), unit };
    }
  }
  return { value: diff, unit: 'second' };
}

export function mergePreviews(previews: DeletePreview[]): DeletePreview {
  const seen = new Map<string, DeletePreview['files'][number]>();
  let bytesFreed = 0;
  let duplicateBytes = 0;
  for (const preview of previews) {
    bytesFreed += preview.bytesFreed;
    for (const file of preview.files) {
      const existing = seen.get(file.path);
      if (existing) {
        duplicateBytes += file.bytes;
        existing.episodes = [
          ...new Set([...existing.episodes, ...file.episodes]),
        ];
      } else {
        seen.set(file.path, { ...file, episodes: [...file.episodes] });
      }
    }
  }
  return {
    files: [...seen.values()],
    bytesFreed: Math.max(0, bytesFreed - duplicateBytes),
    torrentKept: previews.some((p) => p.torrentKept),
  };
}

export const previewEpisodes = (preview: DeletePreview): string[] =>
  [...new Set(preview.files.flatMap((f) => f.episodes))].sort();

export type ControlErrorInfo = { service?: string; message?: string };

const SERVICE_NAMES: Record<string, string> = {
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  transmission: 'Transmission',
};

export function controlErrorInfo(data: unknown): ControlErrorInfo {
  if (typeof data !== 'object' || data === null) return {};
  const body = data as Record<string, unknown>;
  const info: ControlErrorInfo = {};
  if (typeof body.service === 'string') {
    info.service = SERVICE_NAMES[body.service] ?? body.service;
  }
  if (typeof body.message === 'string' && body.message) {
    info.message = body.message;
  }
  return info;
}
