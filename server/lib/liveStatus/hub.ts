import logger from '@server/logger';
import { diffSnapshots } from './delta';
import { deriveRequestState } from './derive';
import {
  servarrEventTarget,
  startServarrSignalR,
  type ServarrMessage,
} from './signalr';
import { sources, type ServiceKind, type ServiceTarget } from './sources';
import type { LiveDelta, RequestLiveState } from './types';

export type LiveEvent =
  | { type: 'snapshot'; state: RequestLiveState }
  | { type: 'delta'; deltas: LiveDelta[] };

export type LiveListener = (e: LiveEvent) => void;

export const POLL_INTERVAL_MS = 2000;

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
  private targets = new Map<number, ServiceTarget>();
  private running = new Map<number, Promise<void>>();
  private queued = new Map<number, Promise<void>>();
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

    for (const id of sub.ids) {
      const cached = this.states.get(id);
      if (cached) {
        this.emit(sub, { type: 'snapshot', state: cached });
      } else {
        sub.pending.add(id);
        if (!this.running.has(id)) {
          void this.run(id);
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
          this.states.delete(id);
          this.targets.delete(id);
        }
      }
      if (this.subscriptions.size === 0) {
        this.stopPolling();
      }
    };
  }

  public refresh(requestId: number): Promise<void> {
    if (!this.isSubscribed(requestId)) {
      return Promise.resolve();
    }
    const current = this.running.get(requestId);
    if (!current) {
      return this.run(requestId);
    }
    let next = this.queued.get(requestId);
    if (!next) {
      next = current.then(() => {
        this.queued.delete(requestId);
        if (!this.isSubscribed(requestId)) return;
        return this.running.get(requestId) ?? this.run(requestId);
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
    await Promise.all(ids.map((id) => this.refresh(id)));
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
      void Promise.all(ids.map((id) => this.refresh(id)));
      return;
    }
    void Promise.all(
      target.map((id) => this.refreshByService(kind, id, serverId))
    );
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
    this.targets.clear();
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
    for (const id of this.subscribedIds()) {
      if (!this.running.has(id)) {
        void this.run(id);
      }
    }
  }

  private run(requestId: number): Promise<void> {
    const promise = this.load(requestId)
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

  private async load(requestId: number): Promise<void> {
    let next: RequestLiveState;
    let target: ServiceTarget | undefined;
    try {
      const request = await sources.findRequest(requestId);
      if (!request) {
        next = this.unavailable(requestId);
      } else {
        target = sources.serviceTarget(request);
        next = deriveRequestState(await sources.loadRequestInputs(request));
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
    }
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
