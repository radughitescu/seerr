import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueueRecord } from '@server/api/servarr/base';
import type { TorrentInfo } from '@server/api/transmission';
import type { RequestItemControl } from '@server/entity/RequestItemControl';
import {
  deriveItemStatus,
  deriveRequestState,
  type ItemInputs,
  type RequestInputs,
} from './derive';

const torrent = (over: Partial<TorrentInfo> = {}): TorrentInfo => ({
  hashString: 'abc',
  name: 'Show.S01.1080p',
  status: 4,
  percentDone: 0.5,
  rateDownload: 1000,
  eta: 60,
  peersSendingToUs: 3,
  peersConnected: 5,
  sizeWhenDone: 400,
  error: 0,
  errorString: '',
  files: [],
  fileStats: [],
  ...over,
});

const queue = (over: Partial<QueueRecord> = {}): QueueRecord => ({
  id: 1,
  downloadId: 'ABC',
  trackedDownloadState: 'downloading',
  trackedDownloadStatus: 'ok',
  statusMessages: [],
  size: 100,
  sizeleft: 50,
  ...over,
});

const item = (over: Partial<ItemInputs> = {}): ItemInputs => ({
  control: null,
  hasFile: false,
  searchRunning: false,
  monitored: true,
  ...over,
});

const control = (
  state: 'paused' | 'deleted',
  seasonNumber: number | null,
  episodeNumber: number | null,
  pausedAtPercent: number | null = null
) =>
  ({
    seasonNumber,
    episodeNumber,
    state,
    pausedAtPercent,
  }) as RequestItemControl;

describe('deriveItemStatus', () => {
  it('control=deleted -> deleted', () => {
    assert.equal(deriveItemStatus(item({ control: 'deleted' })), 'deleted');
  });
  it('deleted wins over hasFile', () => {
    assert.equal(
      deriveItemStatus(item({ control: 'deleted', hasFile: true })),
      'deleted'
    );
  });
  it('control=paused -> paused', () => {
    assert.equal(deriveItemStatus(item({ control: 'paused' })), 'paused');
  });
  it('on_plex wins over a season-level pause', () => {
    assert.equal(
      deriveItemStatus(item({ control: 'paused', hasFile: true })),
      'on_plex'
    );
  });
  it('hasFile -> on_plex', () => {
    assert.equal(deriveItemStatus(item({ hasFile: true })), 'on_plex');
  });
  it('queue error -> failed', () => {
    assert.equal(
      deriveItemStatus(
        item({ queue: queue({ trackedDownloadStatus: 'error' }) })
      ),
      'failed'
    );
  });
  it('torrent error -> failed', () => {
    assert.equal(
      deriveItemStatus(item({ torrent: torrent({ error: 3 }) })),
      'failed'
    );
  });
  it('importPending/importing -> importing', () => {
    for (const s of ['importPending', 'importing']) {
      assert.equal(
        deriveItemStatus(item({ queue: queue({ trackedDownloadState: s }) })),
        'importing'
      );
    }
  });
  it('torrent status 3 -> queued', () => {
    assert.equal(
      deriveItemStatus(item({ torrent: torrent({ status: 3 }) })),
      'queued'
    );
  });
  it('status 4 with item files at 0 bytes -> queued', () => {
    const t = torrent({
      files: [
        { index: 0, name: 'a', length: 100, bytesCompleted: 0 },
        { index: 1, name: 'b', length: 100, bytesCompleted: 100 },
      ],
    });
    assert.equal(
      deriveItemStatus(item({ torrent: t, fileIndexes: [0] })),
      'queued'
    );
    assert.equal(
      deriveItemStatus(item({ torrent: t, fileIndexes: [1] })),
      'downloading'
    );
  });
  it('status 4 with no rate and no peers -> stalled', () => {
    assert.equal(
      deriveItemStatus(
        item({ torrent: torrent({ rateDownload: 0, peersSendingToUs: 0 }) })
      ),
      'stalled'
    );
  });
  it('status 4 -> downloading', () => {
    assert.equal(deriveItemStatus(item({ torrent: torrent() })), 'downloading');
  });
  it('queue importBlocked/failedPending/failed -> failed with status messages', () => {
    for (const st of ['importBlocked', 'failedPending', 'failed']) {
      assert.equal(
        deriveItemStatus(item({ queue: queue({ trackedDownloadState: st }) })),
        'failed'
      );
    }
    const state = deriveRequestState(
      input({
        episodes: [ep(1)],
        queue: [
          queue({
            episodeId: 101,
            trackedDownloadState: 'importBlocked',
            statusMessages: [{ title: 't', messages: ['no space', 'locked'] }],
          }),
        ],
        torrents: [torrent()],
      })
    );
    assert.equal(state.seasons[0].episodes[0].error, 'no space; locked');
  });
  it('torrent status 5 or 6 without file -> importing', () => {
    for (const status of [5, 6] as const) {
      assert.equal(
        deriveItemStatus(item({ torrent: torrent({ status }) })),
        'importing'
      );
    }
  });
  it('torrent status 1 or 2 -> queued', () => {
    for (const status of [1, 2] as const) {
      assert.equal(
        deriveItemStatus(item({ torrent: torrent({ status }) })),
        'queued'
      );
    }
  });
  it('torrent status 0 with no control -> stalled', () => {
    assert.equal(
      deriveItemStatus(item({ torrent: torrent({ status: 0 }) })),
      'stalled'
    );
  });
  it('searchRunning -> searching', () => {
    assert.equal(deriveItemStatus(item({ searchRunning: true })), 'searching');
  });
  it('monitored with lastSearchTime -> not_found', () => {
    assert.equal(
      deriveItemStatus(item({ lastSearchTime: '2026-01-01T00:00:00Z' })),
      'not_found'
    );
  });
  it('otherwise unknown', () => {
    assert.equal(deriveItemStatus(item()), 'unknown');
    assert.equal(
      deriveItemStatus(item({ monitored: false, lastSearchTime: 'x' })),
      'unknown'
    );
  });
});

const ep = (
  episodeNumber: number,
  over: Partial<RequestInputs['episodes'][number]> = {}
) => ({
  id: 100 + episodeNumber,
  seasonNumber: 1,
  episodeNumber,
  title: `Ep ${episodeNumber}`,
  monitored: true,
  hasFile: false,
  ...over,
});

const input = (over: Partial<RequestInputs> = {}): RequestInputs => ({
  requestId: 9,
  type: 'tv',
  now: '2026-01-01T00:00:00Z',
  controls: [],
  episodes: [],
  queue: [],
  torrents: [],
  runningSearches: [],
  requestedSeasons: [1],
  failedSources: [],
  ...over,
});

describe('deriveRequestState', () => {
  it('season status is downloading when one episode downloads and others are on_plex', () => {
    const state = deriveRequestState(
      input({
        episodes: [ep(1, { hasFile: true }), ep(2), ep(3, { hasFile: true })],
        queue: [queue({ episodeId: 102 })],
        torrents: [torrent()],
      })
    );
    assert.equal(state.seasons[0].status, 'downloading');
    assert.equal(state.summary.status, 'downloading');
    assert.deepEqual(state.seasons[0].episodes[0].actions, ['delete']);
  });

  it('summary counts ready/paused/deleted', () => {
    const state = deriveRequestState(
      input({
        controls: [control('paused', 1, 2, 30), control('deleted', 1, 3)],
        episodes: [ep(1, { hasFile: true }), ep(2), ep(3), ep(4)],
      })
    );
    assert.equal(state.summary.ready, 1);
    assert.equal(state.summary.paused, 1);
    assert.equal(state.summary.deleted, 1);
    assert.equal(state.summary.total, 4);
    assert.equal(state.seasons[0].episodes[1].percent, 30);
  });

  it('on_plex stays under a season-level pause', () => {
    const state = deriveRequestState(
      input({
        controls: [control('paused', 1, null)],
        episodes: [ep(1, { hasFile: true }), ep(2)],
      })
    );
    assert.equal(state.seasons[0].episodes[0].status, 'on_plex');
    assert.equal(state.seasons[0].episodes[1].status, 'paused');
  });

  it('episode percent uses its mapped files', () => {
    const t = torrent({
      percentDone: 0.9,
      files: [
        { index: 0, name: 'Show.S01E01.mkv', length: 100, bytesCompleted: 25 },
        { index: 1, name: 'Show.S01E02.mkv', length: 100, bytesCompleted: 100 },
      ],
    });
    const state = deriveRequestState(
      input({
        episodes: [ep(1), ep(2, { hasFile: true })],
        queue: [queue({ episodeId: 101 })],
        torrents: [t],
      })
    );
    assert.equal(state.seasons[0].episodes[0].percent, 25);
    assert.equal(state.seasons[0].episodes[0].etaSeconds, 60);
    assert.equal(state.seasons[0].release?.name, 'Show.S01.1080p');
  });

  it('episode without mapped files uses torrent percentDone', () => {
    const t = torrent({
      percentDone: 0.5,
      files: [
        { index: 0, name: 'pack/video.mkv', length: 100, bytesCompleted: 50 },
      ],
    });
    const state = deriveRequestState(
      input({
        episodes: [ep(1)],
        queue: [queue({ episodeId: 101 })],
        torrents: [t],
      })
    );
    assert.equal(state.seasons[0].episodes[0].percent, 50);
  });

  it('series search for another series does not mark episodes searching', () => {
    const state = deriveRequestState(
      input({
        seriesId: 5,
        episodes: [ep(1)],
        runningSearches: [{ seriesId: 6 }],
      })
    );
    assert.equal(state.seasons[0].episodes[0].status, 'unknown');
    const own = deriveRequestState(
      input({
        seriesId: 5,
        episodes: [ep(1)],
        runningSearches: [{ seriesId: 5 }],
      })
    );
    assert.equal(own.seasons[0].episodes[0].status, 'searching');
  });

  it('sonarr series search does not mark a movie searching', () => {
    const state = deriveRequestState(
      input({
        type: 'movie',
        movieId: 3,
        seriesId: 3,
        movie: { monitored: true, hasFile: false },
        requestedSeasons: [],
        runningSearches: [{ seriesId: 3 }],
      })
    );
    assert.equal(state.movie?.status, 'unknown');
    const own = deriveRequestState(
      input({
        type: 'movie',
        movieId: 3,
        movie: { monitored: true, hasFile: false },
        requestedSeasons: [],
        runningSearches: [{ movieIds: [3] }],
      })
    );
    assert.equal(own.movie?.status, 'searching');
  });

  it('episode paused via season row with no torrent shows the season row pausedAtPercent', () => {
    const state = deriveRequestState(
      input({
        controls: [control('paused', 1, null, 64)],
        episodes: [ep(1)],
      })
    );
    assert.equal(state.seasons[0].episodes[0].status, 'paused');
    assert.equal(state.seasons[0].episodes[0].percent, 64);
  });

  it('available is false when a source failed', () => {
    const state = deriveRequestState(input({ failedSources: ['sonarr'] }));
    assert.equal(state.available, false);
  });

  it('movie derives its own state', () => {
    const state = deriveRequestState(
      input({
        type: 'movie',
        movie: { monitored: true, hasFile: true },
        requestedSeasons: [],
      })
    );
    assert.equal(state.movie?.status, 'on_plex');
    assert.equal(state.summary.total, 1);
    assert.equal(state.summary.ready, 1);
  });
});
