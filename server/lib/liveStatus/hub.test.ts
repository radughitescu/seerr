import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestInputs } from './derive';
import { LiveStatusHub, type LiveEvent } from './hub';
import { sources } from './sources';

const fakeRequest = (id: number, externalServiceId = 5) =>
  ({
    id,
    type: 'tv',
    is4k: false,
    serverId: null,
    media: { externalServiceId },
    seasons: [{ seasonNumber: 1 }],
  }) as unknown as MediaRequest;

let clock = 0;
const inputs = (
  requestId: number,
  over: Partial<RequestInputs> = {}
): RequestInputs => ({
  requestId,
  type: 'tv',
  now: new Date(Date.UTC(2026, 0, 1) + clock++ * 1000).toISOString(),
  controls: [],
  episodes: [
    {
      id: 11,
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Pilot',
      monitored: true,
      hasFile: false,
    },
  ],
  seriesId: 5,
  queue: [],
  torrents: [],
  runningSearches: [],
  requestedSeasons: [1],
  failedSources: [],
  ...over,
});

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('LiveStatusHub', () => {
  let hub: LiveStatusHub;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
    mock.method(sources, 'findRequest', async (id: number) => fakeRequest(id));
    hub = new LiveStatusHub();
  });

  afterEach(() => {
    hub.shutdown();
    mock.timers.reset();
    mock.restoreAll();
  });

  it('first subscriber receives a snapshot synchronously after load', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      inputs(r.id)
    );
    const events: LiveEvent[] = [];
    hub.subscribe([1, 2], (e) => events.push(e));

    await flush();

    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.type),
      ['snapshot', 'snapshot']
    );
    const ids = events.map((e) =>
      e.type === 'snapshot' ? e.state.requestId : -1
    );
    assert.deepEqual(ids.sort(), [1, 2]);
    const first = events[0];
    assert.ok(first.type === 'snapshot' && first.state.available);
  });

  it('second subscriber to a loaded id gets cached snapshot synchronously', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    hub.subscribe([1], () => undefined);
    await flush();

    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'snapshot');
    assert.equal(load.mock.callCount(), 1);
  });

  it('poller ticks every 2000 ms while subscribed and stops after the last unsubscribe', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    const unsubscribe = hub.subscribe([1], () => undefined);
    await flush();
    const initial = load.mock.callCount();
    assert.equal(initial, 1);

    for (let i = 0; i < 3; i++) {
      mock.timers.tick(2000);
      await flush();
    }
    assert.equal(load.mock.callCount() - initial, 3);

    unsubscribe();
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(2000);
      await flush();
    }
    assert.equal(load.mock.callCount() - initial, 3);
    assert.equal(hub.clientCount(), 0);
  });

  it('two subscribers share one poller', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    const a = hub.subscribe([1], () => undefined);
    await flush();
    const b = hub.subscribe([1], () => undefined);
    await flush();
    assert.equal(hub.clientCount(), 2);
    assert.equal(load.mock.callCount(), 1);

    mock.timers.tick(2000);
    await flush();
    assert.equal(load.mock.callCount(), 2);

    a();
    mock.timers.tick(2000);
    await flush();
    assert.equal(load.mock.callCount(), 3);

    b();
    mock.timers.tick(2000);
    await flush();
    assert.equal(load.mock.callCount(), 3);
  });

  it('unchanged state emits no delta', async () => {
    let hasFile = false;
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      inputs(r.id, {
        episodes: [
          {
            id: 11,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Pilot',
            monitored: true,
            hasFile,
          },
        ],
      })
    );
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    mock.timers.tick(2000);
    await flush();
    mock.timers.tick(2000);
    await flush();
    assert.equal(events.length, 1);

    hasFile = true;
    mock.timers.tick(2000);
    await flush();
    assert.equal(events.length, 2);
    const delta = events[1];
    assert.ok(delta.type === 'delta');
    assert.ok(delta.deltas.length > 0);
    assert.ok(delta.deltas.every((d) => d.requestId === 1));
  });

  it('source rejection emits available=false and keeps polling', async () => {
    let fail = false;
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => {
        if (fail) throw new Error('Sonarr down');
        return inputs(r.id);
      }
    );
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    fail = true;
    mock.timers.tick(2000);
    await flush();
    const delta = events[1];
    assert.ok(delta?.type === 'delta');
    assert.deepEqual(
      delta.deltas.find((d) => d.path[0] === 'available'),
      { requestId: 1, path: ['available'], value: false }
    );

    mock.timers.tick(2000);
    await flush();
    assert.equal(load.mock.callCount(), 3);
    assert.equal(events.length, 2);

    fail = false;
    mock.timers.tick(2000);
    await flush();
    const back = events[2];
    assert.ok(back?.type === 'delta');
    assert.ok(
      back.deltas.some((d) => d.path[0] === 'available' && d.value === true)
    );
  });

  it('first load rejection still sends an unavailable snapshot', async () => {
    mock.method(sources, 'loadRequestInputs', async () => {
      throw new Error('Sonarr down');
    });
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    assert.equal(events.length, 1);
    const snap = events[0];
    assert.ok(snap.type === 'snapshot');
    assert.equal(snap.state.requestId, 1);
    assert.equal(snap.state.available, false);
  });

  it('listener that throws does not stop other listeners', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      inputs(r.id)
    );
    const events: LiveEvent[] = [];
    hub.subscribe([1], () => {
      throw new Error('broken client');
    });
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    assert.equal(events.length, 1);
    mock.timers.tick(2000);
    await flush();
    assert.equal(hub.clientCount(), 2);
  });

  it('overlapping tick skips a request still refreshing', async () => {
    const gate = deferred<RequestInputs>();
    const load = mock.method(sources, 'loadRequestInputs', () => gate.promise);
    hub.subscribe([1], () => undefined);
    await flush();
    assert.equal(load.mock.callCount(), 1);

    mock.timers.tick(6000);
    await flush();
    assert.equal(load.mock.callCount(), 1);

    gate.resolve(inputs(1));
    await flush();
    mock.timers.tick(2000);
    await flush();
    assert.equal(load.mock.callCount(), 2);
  });

  it('refresh during a running load runs once more after it finishes', async () => {
    const gate = deferred<RequestInputs>();
    let calls = 0;
    mock.method(sources, 'loadRequestInputs', (r: MediaRequest) => {
      calls++;
      return calls === 1 ? gate.promise : Promise.resolve(inputs(r.id));
    });
    hub.subscribe([1], () => undefined);
    await flush();

    const first = hub.refresh(1);
    const second = hub.refresh(1);
    gate.resolve(inputs(1));
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  });

  it('unsubscribe drops the cached state', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    const off = hub.subscribe([1], () => undefined);
    await flush();
    off();

    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    assert.equal(events.length, 0);
    await flush();
    assert.equal(events.length, 1);
    assert.equal(load.mock.callCount(), 2);
  });

  it('refreshByService refreshes only subscribed requests for that series', async () => {
    mock.method(sources, 'findRequest', async (id: number) =>
      fakeRequest(id, id === 1 ? 5 : 6)
    );
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    hub.subscribe([1, 2], () => undefined);
    await flush();
    assert.equal(load.mock.callCount(), 2);

    await hub.refreshByService('sonarr', 5);
    assert.equal(load.mock.callCount(), 3);
    assert.equal((load.mock.calls[2].arguments[0] as MediaRequest).id, 1);

    await hub.refreshByService('radarr', 5);
    await hub.refreshByService('sonarr', 99);
    assert.equal(load.mock.callCount(), 3);
  });

  it('servarr queue event refreshes every subscribed request of that kind', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => inputs(r.id)
    );
    hub.subscribe([1, 2], () => undefined);
    await flush();

    hub.handleServarrEvent('sonarr', 0, {
      name: 'queue',
      body: { action: 'sync' },
    });
    await flush();
    assert.equal(load.mock.callCount(), 4);

    hub.handleServarrEvent('sonarr', 0, {
      name: 'episode',
      body: { action: 'updated', resource: { seriesId: 5 } },
    });
    await flush();
    assert.equal(load.mock.callCount(), 6);

    hub.handleServarrEvent('radarr', 0, {
      name: 'movie',
      body: { action: 'updated', resource: { id: 5 } },
    });
    hub.handleServarrEvent('sonarr', 0, { name: 'health', body: {} });
    await flush();
    assert.equal(load.mock.callCount(), 6);
  });
});
