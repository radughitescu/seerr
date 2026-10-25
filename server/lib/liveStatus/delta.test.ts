import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyDelta, diffSnapshots } from './delta';
import type { ItemState, RequestLiveState } from './types';

const ep = (n: number, extra: Partial<ItemState> = {}): ItemState => ({
  seasonNumber: 1,
  episodeNumber: n,
  status: 'downloading',
  percent: 10,
  actions: ['prioritize', 'pause', 'delete'],
  ...extra,
});

const base = (): RequestLiveState => ({
  requestId: 1,
  available: true,
  summary: {
    status: 'downloading',
    percent: 10,
    ready: 0,
    total: 2,
    paused: 0,
    deleted: 0,
  },
  seasons: [
    {
      seasonNumber: 1,
      status: 'downloading',
      episodes: [ep(1), ep(2)],
      actions: ['prioritize', 'pause', 'delete'],
    },
  ],
  actions: ['prioritize', 'pause', 'delete'],
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('delta', () => {
  it('no deltas for equal states', () => {
    assert.deepEqual(diffSnapshots(base(), base()), []);
  });

  it('whole new state yields one root delta', () => {
    const d = diffSnapshots(undefined, base());
    assert.equal(d.length, 1);
    assert.deepEqual(d[0].path, []);
  });

  it('single episode percent change yields one leaf delta', () => {
    const next = base();
    next.seasons[0].episodes[1].percent = 42;
    const d = diffSnapshots(base(), next);
    assert.deepEqual(d, [
      {
        requestId: 1,
        path: ['seasons', 0, 'episodes', 1, 'percent'],
        value: 42,
      },
    ]);
  });

  it('applyDelta does not mutate its input', () => {
    const a = base();
    const next = base();
    next.seasons[0].episodes[1].percent = 42;
    const [d] = diffSnapshots(a, next);
    const out = applyDelta(a, d);
    assert.equal(a.seasons[0].episodes[1].percent, 10);
    assert.equal(out.seasons[0].episodes[1].percent, 42);
    assert.equal(out.seasons[0].episodes[0], a.seasons[0].episodes[0]);
  });

  it('applyDelta(diff(a,b)) equals b', () => {
    const a1 = base();
    const b1 = base();
    b1.seasons[0].episodes[0] = ep(1, {
      status: 'on_plex',
      percent: undefined,
      actions: ['delete'],
    });
    b1.summary.ready = 1;
    b1.updatedAt = '2026-01-01T00:00:02Z';

    const a2 = base();
    const b2 = base();
    b2.seasons[0].episodes.push(ep(3));
    b2.summary.total = 3;
    b2.seasons[0].release = { name: 'r', sizeBytes: 1, peers: 2, rateBytes: 3 };

    const a3 = base();
    const b3 = base();
    b3.available = false;
    b3.movie = {
      seasonNumber: null,
      episodeNumber: null,
      status: 'unknown',
      actions: [],
    };
    b3.seasons = [];

    for (const [a, b] of [
      [a1, b1],
      [a2, b2],
      [a3, b3],
    ]) {
      const deltas = diffSnapshots(a, b);
      assert.ok(deltas.length > 0);
      const out = deltas.reduce(applyDelta, a);
      assert.deepEqual(
        JSON.parse(JSON.stringify(out)),
        JSON.parse(JSON.stringify(b))
      );
    }
  });
});
