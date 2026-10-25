import type { TorrentInfo } from '@server/api/transmission';
import logger from '@server/logger';
import { diffSnapshots } from './delta';
import { deriveRequestState, type RequestInputs } from './derive';
import {
  servarrEventTarget,
  startServarrSignalR,
  type ServarrMessage,
} from './signalr';
import {
  newRound,
  sources,
  torrentHashes,
  type ServarrRound,
  type ServiceKind,
  type ServiceTarget,
} from './sources';
import type { LiveDelta, RequestLiveState } from './types';

export type LiveEvent =
  | { type: 'snapshot'; state: RequestLiveState }
  | { type: 'delta'; deltas: LiveDelta[] };

export type LiveListener = (e: LiveEvent) => void;

export const POLL_INTERVAL_MS = 2000;
export const FULL_ROUND_MS = 30000;

const FULL_ROUND_TICKS = FULL_ROUND_MS / POLL_INTERVAL_MS;

type Subscription = {
  ids: Set<number>;
  listener: LiveListener;
  pending: Set<number>;
};

const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

export class LiveStatusHub {
  private subscriptions = new Set<Subscription>();
  private states = new Map<number, RequestLiveState>();
  private inputs = new Map<number, RequestInputs>();
  private targets = new Map<number, ServiceTarget>();
  private lastFullRound = new Map<number, number>();
  private running = new Map<number, Promise<void>>();
  private queued = new Map<number, Promise<void>>();
  private torrentPoll?: Promise<void>;
  private tickCount = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopServarrSignalR?: () => void;
  private servarrStarted = false;

  public subscribe(requestIds: number[], listener: LiveListener): () => void {
    const sub: Subscription = {
      ids: new Set(requestIds),
      listener,
      pending: new Set(),
    };
    this.subscriptions.add(sub);

    const round = newRound();
    for (const id of sub.ids) {
      const cached = this.states.get(id);
      if (cached) {
        this.emit(sub, { type: 'snapshot', state: cached });
      } else {
        sub.pending.add(id);
        if (!this.running.has(id)) {
          void this.run(id, round);
        }
      }
    }

    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(sub);
      for (const id of sub.ids) {
        if (!this.isSubscribed(id)) {
          this.forget(id);
        }
      }
      if (this.subscriptions.size === 0) {
        this.stopPolling();
      }
    };
  }

  public refresh(requestId: number, round?: ServarrRound): Promise<void> {
    if (!this.isSubscribed(requestId)) {
      return Promise.resolve();
    }
    const current = this.running.get(requestId);
    if (!current) {
      return this.run(requestId, round ?? newRound());
    }
    let next = this.queued.get(requestId);
    if (!next) {
      next = current.then(() => {
        this.queued.delete(requestId);
        if (!this.isSubscribed(requestId)) return;
        return this.running.get(requestId) ?? this.run(requestId, newRound());
      });
      this.queued.set(requestId, next);
    }
    return next;
  }

  public async refreshByService(
    kind: ServiceKind,
    externalId: number,
    serverId?: number
  ): Promise<void> {
    const ids = this.matching(
      (t) =>
        t.kind === kind &&
        t.externalId === externalId &&
        (serverId === undefined ||
          t.serverId === undefined ||
          t.serverId === serverId)
    );
    const round = newRound();
    await Promise.all(ids.map((id) => this.refresh(id, round)));
  }

  public handleServarrEvent(
    kind: ServiceKind,
    serverId: number,
    msg: ServarrMessage
  ): void {
    const target = servarrEventTarget(msg);
    if (target === null) return;
    if (target === 'all') {
      const ids = this.matching(
        (t) =>
          t.kind === kind &&
          (t.serverId === undefined || t.serverId === serverId)
      );
      const round = newRound();
      void Promise.all(ids.map((id) => this.refresh(id, round)));
      return;
    }
    void Promise.all(
      target.map((id) => this.refreshByService(kind, id, serverId))
    );
  }

  public cachedState(requestId: number): RequestLiveState | undefined {
    return this.states.get(requestId);
  }

  public clientCount(): number {
    return this.subscriptions.size;
  }

  public startServarr(): void {
    if (this.servarrStarted) return;
    this.servarrStarted = true;
    this.connectServarr();
  }

  public restartServarr(): void {
    if (!this.servarrStarted) return;
    this.disconnectServarr();
    this.connectServarr();
  }

  public shutdown(): void {
    this.stopPolling();
    this.disconnectServarr();
    this.servarrStarted = false;
    this.subscriptions.clear();
    this.states.clear();
    this.inputs.clear();
    this.targets.clear();
    this.lastFullRound.clear();
  }

  private connectServarr(): void {
    try {
      this.stopServarrSignalR = startServarrSignalR((kind, serverId, msg) =>
        this.handleServarrEvent(kind, serverId, msg)
      );
    } catch (e) {
      logger.error('Failed to start Servarr SignalR connections', {
        label: 'LiveStatus',
        errorMessage: errorMessage(e),
      });
    }
  }

  private disconnectServarr(): void {
    try {
      this.stopServarrSignalR?.();
    } catch (e) {
      logger.error('Failed to stop Servarr SignalR connections', {
        label: 'LiveStatus',
        errorMessage: errorMessage(e),
      });
    }
    this.stopServarrSignalR = undefined;
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private forget(requestId: number): void {
    this.states.delete(requestId);
    this.inputs.delete(requestId);
    this.targets.delete(requestId);
    this.lastFullRound.delete(requestId);
  }

  private subscribedIds(): Set<number> {
    const ids = new Set<number>();
    for (const sub of this.subscriptions) {
      for (const id of sub.ids) ids.add(id);
    }
    return ids;
  }

  private isSubscribed(requestId: number): boolean {
    for (const sub of this.subscriptions) {
      if (sub.ids.has(requestId)) return true;
    }
    return false;
  }

  private matching(predicate: (t: ServiceTarget) => boolean): number[] {
    return [...this.subscribedIds()].filter((id) => {
      const target = this.targets.get(id);
      return target !== undefined && predicate(target);
    });
  }

  private tick(): void {
    this.tickCount++;
    const due: number[] = [];
    const polled: number[] = [];
    for (const id of this.subscribedIds()) {
      if (this.running.has(id)) continue;
      const last = this.lastFullRound.get(id);
      if (last === undefined || this.tickCount - last >= FULL_ROUND_TICKS) {
        due.push(id);
      } else {
        polled.push(id);
      }
    }

    if (due.length) {
      const round = newRound();
      for (const id of due) {
        void this.run(id, round);
      }
    }

    if (polled.length && !this.torrentPoll) {
      this.torrentPoll = this.pollTorrents(polled)
        .catch((e) => {
          logger.error('Live status torrent poll failed', {
            label: 'LiveStatus',
            errorMessage: errorMessage(e),
          });
        })
        .finally(() => {
          this.torrentPoll = undefined;
        });
    }
  }

  private async pollTorrents(ids: number[]): Promise<void> {
    const watched: {
      id: number;
      inputs: RequestInputs;
      hashes: Set<string>;
    }[] = [];
    const all = new Map<string, string>();
    for (const id of ids) {
      const inputs = this.inputs.get(id);
      if (!inputs) continue;
      const hashes = torrentHashes(inputs.queue);
      if (!hashes.length) continue;
      for (const hash of hashes) all.set(hash.toLowerCase(), hash);
      watched.push({
        id,
        inputs,
        hashes: new Set(hashes.map((h) => h.toLowerCase())),
      });
    }
    if (!all.size) return;

    let torrents: TorrentInfo[] | undefined;
    try {
      torrents = await sources.loadTorrents([...all.values()]);
    } catch (e) {
      logger.warn('Failed to poll Transmission for live status', {
        label: 'LiveStatus',
        errorMessage: errorMessage(e),
      });
    }

    const now = new Date().toISOString();
    for (const { id, inputs, hashes } of watched) {
      if (
        !this.isSubscribed(id) ||
        this.running.has(id) ||
        this.inputs.get(id) !== inputs
      ) {
        continue;
      }
      const others = inputs.failedSources.filter((s) => s !== 'transmission');
      const next: RequestInputs = torrents
        ? {
            ...inputs,
            now,
            torrents: torrents.filter((t) =>
              hashes.has(t.hashString.toLowerCase())
            ),
            failedSources: others,
          }
        : { ...inputs, now, failedSources: [...others, 'transmission'] };
      this.inputs.set(id, next);
      this.apply(id, deriveRequestState(next));
    }
  }

  private run(requestId: number, round: ServarrRound): Promise<void> {
    const promise = this.load(requestId, round)
      .catch((e) => {
        logger.error('Live status refresh failed', {
          label: 'LiveStatus',
          requestId,
          errorMessage: errorMessage(e),
        });
      })
      .finally(() => {
        this.running.delete(requestId);
      });
    this.running.set(requestId, promise);
    return promise;
  }

  private async load(requestId: number, round: ServarrRound): Promise<void> {
    let next: RequestLiveState;
    let inputs: RequestInputs | undefined;
    let target: ServiceTarget | undefined;
    try {
      const request = await sources.findRequest(requestId);
      if (!request) {
        next = this.unavailable(requestId);
      } else {
        const resolution = await sources.resolveTarget(request);
        if (resolution.status === 'found') {
          target = resolution.target;
        }
        inputs = await sources.loadRequestInputs(request, round, resolution);
        next = deriveRequestState(inputs);
      }
    } catch (e) {
      logger.warn('Failed to load live request status', {
        label: 'LiveStatus',
        requestId,
        errorMessage: errorMessage(e),
      });
      next = this.unavailable(requestId);
    }

    if (!this.isSubscribed(requestId)) return;
    if (target) {
      this.targets.set(requestId, target);
    } else {
      this.targets.delete(requestId);
    }
    if (inputs) {
      this.inputs.set(requestId, inputs);
    } else {
      this.inputs.delete(requestId);
    }
    this.lastFullRound.set(requestId, this.tickCount);
    this.apply(requestId, next);
  }

  private apply(requestId: number, next: RequestLiveState): void {
    const prev = this.states.get(requestId);
    this.states.set(requestId, next);
    this.publish(requestId, prev, next);
  }

  private unavailable(requestId: number): RequestLiveState {
    const now = new Date().toISOString();
    const prev = this.states.get(requestId);
    if (prev) {
      return { ...prev, available: false, updatedAt: now };
    }
    return {
      requestId,
      available: false,
      summary: { status: 'unknown', ready: 0, total: 0, paused: 0, deleted: 0 },
      seasons: [],
      actions: [],
      updatedAt: now,
    };
  }

  private publish(
    requestId: number,
    prev: RequestLiveState | undefined,
    next: RequestLiveState
  ): void {
    let deltas: LiveDelta[] | undefined;
    for (const sub of [...this.subscriptions]) {
      if (!sub.ids.has(requestId) || !this.subscriptions.has(sub)) continue;
      if (sub.pending.delete(requestId)) {
        this.emit(sub, { type: 'snapshot', state: next });
        continue;
      }
      deltas ??= diffSnapshots(prev, next);
      if (deltas.length) {
        this.emit(sub, { type: 'delta', deltas });
      }
    }
  }

  private emit(sub: Subscription, event: LiveEvent): void {
    try {
      sub.listener(event);
    } catch (e) {
      logger.error('Live status listener failed', {
        label: 'LiveStatus',
        errorMessage: errorMessage(e),
      });
    }
  }
}

export const liveStatusHub = new LiveStatusHub();

export default liveStatusHub;
