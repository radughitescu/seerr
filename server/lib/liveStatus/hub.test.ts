import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { QueueRecord } from '@server/api/servarr/base';
import type { TorrentInfo } from '@server/api/transmission';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestInputs } from './derive';
import { LiveStatusHub, type LiveEvent } from './hub';
import { sources } from './sources';

const HASH_A = 'A'.repeat(40);
const HASH_B = 'B'.repeat(40);

const fakeRequest = (id: number, externalServiceId = 5) =>
  ({
    id,
    type: 'tv',
    is4k: false,
    serverId: null,
    media: { externalServiceId },
    seasons: [{ seasonNumber: 1 }],
  }) as unknown as MediaRequest;

const queueRecord = (downloadId: string, episodeId = 11): QueueRecord => ({
  id: 1,
  downloadId,
  episodeId,
  trackedDownloadState: 'downloading',
  trackedDownloadStatus: 'ok',
  statusMessages: [],
  size: 100,
  sizeleft: 50,
});

const torrent = (hash: string, percentDone = 0.5): TorrentInfo => ({
  hashString: hash.toLowerCase(),
  name: 'Show.S01',
  status: 4,
  percentDone,
  rateDownload: 100,
  eta: 60,
  peersSendingToUs: 2,
  peersConnected: 3,
  sizeWhenDone: 1000,
  error: 0,
  errorString: '',
  files: [],
  fileStats: [],
});

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

const downloading = (requestId: number, hash = HASH_A) =>
  inputs(requestId, { queue: [queueRecord(hash)], torrents: [torrent(hash)] });

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const ticks = async (count: number) => {
  for (let i = 0; i < count; i++) {
    mock.timers.tick(2000);
    await flush();
  }
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const cachedInputs = (hub: LiveStatusHub, id: number) =>
  (hub as unknown as { inputs: Map<number, RequestInputs> }).inputs.get(id);

describe('LiveStatusHub', () => {
  let hub: LiveStatusHub;
  let find: ReturnType<typeof mock.method>;

  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
    find = mock.method(sources, 'findRequest', async (id: number) =>
      fakeRequest(id)
    );
    hub = new LiveStatusHub();
  });

  afterEach(() => {
    hub.shutdown();
    mock.timers.reset();
    mock.restoreAll();
  });

  it('first subscriber receives a snapshot synchronously after load', async () => {
    const load = mock.method(sources, 'loadRequestInputs', (async (
      r: MediaRequest
    ) => inputs(r.id)) as typeof sources.loadRequestInputs);
    const events: LiveEvent[] = [];
    hub.subscribe([1, 2], (e) => events.push(e));

    await flush();

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
    assert.equal(
      load.mock.calls[0].arguments[1],
      load.mock.calls[1].arguments[1]
    );
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
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      downloading(r.id)
    );
    const poll = mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A),
    ]);
    const unsubscribe = hub.subscribe([1], () => undefined);
    await flush();

    await ticks(3);
    assert.equal(poll.mock.callCount(), 3);

    unsubscribe();
    await ticks(3);
    assert.equal(poll.mock.callCount(), 3);
    assert.equal(hub.clientCount(), 0);
  });

  it('tick does not call servarr', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => downloading(r.id)
    );
    mock.method(sources, 'loadTorrents', async () => [torrent(HASH_A)]);
    hub.subscribe([1], () => undefined);
    await flush();

    await ticks(5);
    assert.equal(load.mock.callCount(), 1);
    assert.equal(find.mock.callCount(), 1);
  });

  it('tick with no cached torrent hashes makes no transmission or servarr calls', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) =>
        inputs(r.id, { queue: [queueRecord('SABnzbd_nzo_1')] })
    );
    const poll = mock.method(sources, 'loadTorrents', async () => []);
    hub.subscribe([1, 2], () => undefined);
    await flush();

    await ticks(5);
    assert.equal(poll.mock.callCount(), 0);
    assert.equal(load.mock.callCount(), 2);
  });

  it('tick batches hashes of all subscribed requests into one getTorrents call', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      r.id === 1
        ? downloading(1, HASH_A)
        : inputs(2, {
            queue: [queueRecord(HASH_B), queueRecord(HASH_A, 12)],
          })
    );
    const poll = mock.method(sources, 'loadTorrents', (async () => [
      torrent(HASH_A, 0.6),
      torrent(HASH_B),
    ]) as typeof sources.loadTorrents);
    hub.subscribe([1], () => undefined);
    hub.subscribe([2], () => undefined);
    await flush();

    await ticks(1);
    assert.equal(poll.mock.callCount(), 1);
    assert.deepEqual([...poll.mock.calls[0].arguments[0]].sort(), [
      HASH_A,
      HASH_B,
    ]);
    assert.deepEqual(
      cachedInputs(hub, 1)?.torrents.map((t) => t.hashString),
      [HASH_A.toLowerCase()]
    );
    assert.deepEqual(
      cachedInputs(hub, 2)
        ?.torrents.map((t) => t.hashString)
        .sort(),
      [HASH_A.toLowerCase(), HASH_B.toLowerCase()]
    );
  });

  it('servarr round runs again after 30000 ms', async () => {
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => downloading(r.id)
    );
    mock.method(sources, 'loadTorrents', async () => [torrent(HASH_A)]);
    hub.subscribe([1], () => undefined);
    await flush();

    await ticks(14);
    assert.equal(load.mock.callCount(), 1);
    await ticks(1);
    assert.equal(load.mock.callCount(), 2);
    await ticks(14);
    assert.equal(load.mock.callCount(), 2);
    await ticks(1);
    assert.equal(load.mock.callCount(), 3);
  });

  it('two subscribers share one poller', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      downloading(r.id)
    );
    const poll = mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A),
    ]);
    const a = hub.subscribe([1], () => undefined);
    await flush();
    const b = hub.subscribe([1], () => undefined);
    await flush();
    assert.equal(hub.clientCount(), 2);

    await ticks(1);
    assert.equal(poll.mock.callCount(), 1);

    a();
    await ticks(1);
    assert.equal(poll.mock.callCount(), 2);

    b();
    await ticks(1);
    assert.equal(poll.mock.callCount(), 2);
  });

  it('unsubscribing twice leaves other subscriptions and the poller intact', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      downloading(r.id)
    );
    const poll = mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A),
    ]);
    const a = hub.subscribe([1], () => undefined);
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    a();
    a();
    assert.equal(hub.clientCount(), 1);

    await ticks(2);
    assert.equal(poll.mock.callCount(), 2);
    assert.equal(events.length, 1);
  });

  it('unchanged state emits no delta', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      downloading(r.id)
    );
    let percent = 0.5;
    mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A, percent),
    ]);
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    await ticks(2);
    assert.equal(events.length, 1);

    percent = 0.75;
    await ticks(1);
    assert.equal(events.length, 2);
    const delta = events[1];
    assert.ok(delta.type === 'delta');
    assert.ok(delta.deltas.length > 0);
    assert.ok(delta.deltas.every((d) => d.requestId === 1));
  });

  it('source rejection emits available=false and keeps polling', async () => {
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) =>
      downloading(r.id)
    );
    let fail = false;
    const poll = mock.method(sources, 'loadTorrents', async () => {
      if (fail) throw new Error('Transmission down');
      return [torrent(HASH_A)];
    });
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    fail = true;
    await ticks(1);
    const delta = events[1];
    assert.ok(delta?.type === 'delta');
    assert.deepEqual(
      delta.deltas.find((d) => d.path[0] === 'available'),
      { requestId: 1, path: ['available'], value: false }
    );

    await ticks(1);
    assert.equal(poll.mock.callCount(), 2);
    assert.equal(events.length, 2);

    fail = false;
    await ticks(1);
    const back = events[2];
    assert.ok(back?.type === 'delta');
    assert.ok(
      back.deltas.some((d) => d.path[0] === 'available' && d.value === true)
    );
    assert.deepEqual(cachedInputs(hub, 1)?.failedSources, []);
  });

  it('full round rejection emits available=false', async () => {
    let fail = false;
    mock.method(sources, 'loadRequestInputs', async (r: MediaRequest) => {
      if (fail) throw new Error('Sonarr down');
      return inputs(r.id);
    });
    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    await flush();

    fail = true;
    await hub.refresh(1);
    const delta = events[1];
    assert.ok(delta?.type === 'delta');
    assert.ok(
      delta.deltas.some((d) => d.path[0] === 'available' && d.value === false)
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
      downloading(r.id)
    );
    let percent = 0.5;
    mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A, (percent += 0.1)),
    ]);
    const events: LiveEvent[] = [];
    hub.subscribe([1], () => {
      throw new Error('broken client');
    });
    hub.subscribe([1], (e) => events.push(e));
    await flush();
    assert.equal(events.length, 1);

    await ticks(1);
    assert.equal(events.length, 2);
    assert.equal(hub.clientCount(), 2);
  });

  it('overlapping tick skips a request still refreshing', async () => {
    const gate = deferred<RequestInputs>();
    const load = mock.method(sources, 'loadRequestInputs', () => gate.promise);
    const poll = mock.method(sources, 'loadTorrents', async () => [
      torrent(HASH_A),
    ]);
    hub.subscribe([1], () => undefined);
    await flush();

    await ticks(3);
    assert.equal(load.mock.callCount(), 1);
    assert.equal(poll.mock.callCount(), 0);

    gate.resolve(downloading(1));
    await flush();
    await ticks(1);
    assert.equal(load.mock.callCount(), 1);
    assert.equal(poll.mock.callCount(), 1);
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

  it('a load resolving after the last unsubscribe is discarded', async () => {
    const gate = deferred<RequestInputs>();
    let calls = 0;
    mock.method(sources, 'loadRequestInputs', (r: MediaRequest) => {
      calls++;
      return calls === 1 ? gate.promise : Promise.resolve(inputs(r.id));
    });
    const stale: LiveEvent[] = [];
    const off = hub.subscribe([1], (e) => stale.push(e));
    await flush();
    off();
    gate.resolve(inputs(1));
    await flush();
    assert.equal(stale.length, 0);
    assert.equal(cachedInputs(hub, 1), undefined);

    const events: LiveEvent[] = [];
    hub.subscribe([1], (e) => events.push(e));
    assert.equal(events.length, 0);
    await flush();
    assert.equal(events.length, 1);
    assert.equal(calls, 2);
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

  it('signalr event triggers a full round for the matching request only', async () => {
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

    hub.handleServarrEvent('sonarr', 0, {
      name: 'episode',
      body: { action: 'updated', resource: { seriesId: 5 } },
    });
    await flush();
    assert.equal(load.mock.callCount(), 3);
    assert.equal((load.mock.calls[2].arguments[0] as MediaRequest).id, 1);

    hub.handleServarrEvent('radarr', 0, {
      name: 'movie',
      body: { action: 'updated', resource: { id: 5 } },
    });
    hub.handleServarrEvent('sonarr', 0, { name: 'health', body: {} });
    await flush();
    assert.equal(load.mock.callCount(), 3);
  });

  it('servarr queue event refreshes every subscribed request of that kind', async () => {
    const load = mock.method(sources, 'loadRequestInputs', (async (
      r: MediaRequest
    ) => inputs(r.id)) as typeof sources.loadRequestInputs);
    hub.subscribe([1, 2], () => undefined);
    await flush();

    hub.handleServarrEvent('sonarr', 0, {
      name: 'queue',
      body: { action: 'sync' },
    });
    await flush();
    assert.equal(load.mock.callCount(), 4);
    assert.equal(
      load.mock.calls[2].arguments[1],
      load.mock.calls[3].arguments[1]
    );
  });
});
