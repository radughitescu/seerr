export type ItemStatus =
  | 'searching'
  | 'not_found'
  | 'queued'
  | 'downloading'
  | 'stalled'
  | 'paused'
  | 'importing'
  | 'on_plex'
  | 'deleted'
  | 'failed'
  | 'unknown';

export type ItemAction =
  | 'prioritize'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'restore';

export interface ItemState {
  seasonNumber: number | null;
  episodeNumber: number | null;
  title?: string;
  status: ItemStatus;
  percent?: number;
  bytesOnDisk?: number;
  etaSeconds?: number;
  lastSearchedAt?: string;
  error?: string;
  actions: ItemAction[];
}

export interface SeasonState {
  seasonNumber: number;
  status: ItemStatus;
  release?: {
    name: string;
    sizeBytes: number;
    peers: number;
    rateBytes: number;
  };
  episodes: ItemState[];
  actions: ItemAction[];
}

export interface RequestLiveState {
  requestId: number;
  available: boolean;
  summary: {
    status: ItemStatus;
    percent?: number;
    ready: number;
    total: number;
    paused: number;
    deleted: number;
    etaSeconds?: number;
  };
  seasons: SeasonState[];
  movie?: ItemState;
  actions: ItemAction[];
  updatedAt: string;
}

export type LiveDelta = {
  requestId: number;
  path: (string | number)[];
  value: unknown;
};
