import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { QueueRecord } from '@server/api/servarr/base';
import type { TorrentInfo } from '@server/api/transmission';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { liveStatusHub } from '@server/lib/liveStatus/hub';
import { clients } from '@server/lib/liveStatus/sources';
import type {
  ItemAction,
  RequestLiveState,
} from '@server/lib/liveStatus/types';
import type {
  RadarrSettings,
  SonarrSettings,
  TransmissionSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { ActionError, ServiceError, runAction } from './actions';
import { getDeletePreview } from './preview';
import { getControls, setControl } from './store';

setupTestDb();

function stubSubscribers() {
  mock.method(MediaRequest, 'sendNotification', async () => undefined);

  for (const method of [
    'sendToRadarr',
    'sendToSonarr',
    'updateParentStatus',
    'handleRemoveParentUpdate',
  ] as const) {
    mock.method(
      MediaRequestSubscriber.prototype,
      method,
      async () => undefined
    );
  }
}

stubSubscribers();

const SINGLE = 'a'.repeat(40);
const PACK = 'b'.repeat(40);

type Episode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
  episodeFileId?: number;
  monitored?: boolean;
};

type World = {
  episodes?: Episode[];
  episodeFiles?: { id: number; path: string; size: number }[];
  queue?: QueueRecord[];
  torrents?: TorrentInfo[];
  movie?: { hasFile: boolean; monitored?: boolean };
  movieFiles?: { id: number; path: string; size: number }[];
  history?: History[];
};

type History = {
  episodeId?: number;
  movieId?: number;
  downloadId: string;
  eventType: string;
};

const grabbed = (downloadId: string, ...episodeIds: number[]): History[] =>
  episodeIds.flatMap((episodeId) => [
    { episodeId, downloadId, eventType: 'grabbed' },
    { episodeId, downloadId, eventType: 'downloadFolderImported' },
  ]);

const ep = (episodeNumber: number, over: Partial<Episode> = {}): Episode => ({
  id: 100 + episodeNumber,
  seasonNumber: 1,
  episodeNumber,
  hasFile: false,
  ...over,
});

const q = (id: number, downloadId: string, target: number): QueueRecord => ({
  id,
  downloadId,
  ...(target === 9 ? { movieId: 9 } : { episodeId: target }),
  trackedDownloadState: 'downloading',
  trackedDownloadStatus: 'ok',
  statusMessages: [],
  size: 100,
  sizeleft: 50,
});

const torrent = (
  hash: string,
  files: [name: string, length: number, done: number, wanted?: boolean][],
  over: Partial<TorrentInfo> = {}
): TorrentInfo => ({
  hashString: hash,
  name: 'release',
  status: 4,
  percentDone: 0.5,
  rateDownload: 100,
  eta: 60,
  peersSendingToUs: 1,
  peersConnected: 1,
  sizeWhenDone: files.reduce((s, f) => s + f[1], 0),
  error: 0,
  errorString: '',
  files: files.map(([name, length, bytesCompleted], index) => ({
    index,
    name,
    length,
    bytesCompleted,
  })),
  fileStats: files.map((f) => ({ wanted: f[3] ?? true, priority: 0 })),
  ...over,
});

const pack = (over: Partial<TorrentInfo> = {}) =>
  torrent(
    PACK,
    [
      ['Show.S01/Show.S01E01.mkv', 1000, 1000],
      ['Show.S01/Show.S01E02.mkv', 1000, 1000],
      ['Show.S01/Show.S01E03.mkv', 1000, 400],
    ],
    over
  );

const packQueue = () => [q(11, PACK, 101), q(12, PACK, 102), q(13, PACK, 103)];

const server = (id: number) =>
  ({
    id,
    name: `server-${id}`,
    hostname: `host-${id}`,
    port: 8989,
    apiKey: `key-${id}`,
    useSsl: false,
    is4k: false,
    isDefault: true,
  }) as SonarrSettings & RadarrSettings;

type Log = unknown[][];

function install(world: World) {
  const log: Log = [];
  const write =
    (name: string, fail?: () => Error) =>
    async (...args: unknown[]) => {
      log.push([name, ...args]);
      if (fail) throw fail();
    };
  const sonarr = {
    getEpisodes: mock.fn(async () =>
      (world.episodes ?? []).map((e) => ({
        seriesId: 42,
        title: `E${e.episodeNumber}`,
        monitored: e.monitored ?? true,
        episodeFileId: e.episodeFileId ?? 0,
        lastSearchTime: '2026-10-01T00:00:00Z',
        ...e,
      }))
    ),
    getEpisodeFiles: mock.fn(async () =>
      (world.episodeFiles ?? []).map((f) => ({
        seriesId: 42,
        seasonNumber: 1,
        relativePath: f.path,
        ...f,
      }))
    ),
    getQueueFor: mock.fn(async () =>
      (world.queue ?? []).filter((r) => r.movieId === undefined)
    ),
    getSeriesHistory: mock.fn(async () =>
      (world.history ?? []).filter((h) => h.movieId === undefined)
    ),
    getCommands: mock.fn(async () => []),
    setEpisodesMonitored: mock.fn(write('setEpisodesMonitored')),
    setSeasonMonitored: mock.fn(write('setSeasonMonitored')),
    searchEpisodes: mock.fn(write('searchEpisodes')),
    searchSeason: mock.fn(write('searchSeason')),
    deleteEpisodeFiles: mock.fn(write('deleteEpisodeFiles')),
    removeQueueItems: mock.fn(write('sonarr.removeQueueItems')),
  };
  const radarr = {
    getMovie: mock.fn(async () => ({
      id: 9,
      monitored: world.movie?.monitored ?? true,
      hasFile: world.movie?.hasFile ?? false,
    })),
    getMovieFiles: mock.fn(async () =>
      (world.movieFiles ?? []).map((f) => ({
        movieId: 9,
        relativePath: f.path,
        ...f,
      }))
    ),
    getQueueFor: mock.fn(async () =>
      (world.queue ?? []).filter((r) => r.movieId !== undefined)
    ),
    getMovieHistory: mock.fn(async () =>
      (world.history ?? []).filter((h) => h.movieId !== undefined)
    ),
    getCommands: mock.fn(async () => []),
    setMovieMonitored: mock.fn(write('setMovieMonitored')),
    searchMovie: mock.fn(write('searchMovie')),
    searchMovieStrict: mock.fn(write('searchMovieStrict')),
    deleteMovieFile: mock.fn(write('deleteMovieFile')),
    removeQueueItems: mock.fn(write('radarr.removeQueueItems')),
  };
  const transmission = {
    getTorrents: mock.fn(async (hashes: string[]) =>
      (world.torrents ?? []).filter((t) =>
        hashes.map((h) => h.toLowerCase()).includes(t.hashString)
      )
    ),
    start: mock.fn(write('start')),
    stop: mock.fn(write('stop')),
    remove: mock.fn(write('remove')),
    setFilesWanted: mock.fn(write('setFilesWanted')),
    setFilePriorityHigh: mock.fn(write('setFilePriorityHigh')),
    queueMoveTop: mock.fn(write('queueMoveTop')),
    setBandwidthPriorityHigh: mock.fn(write('setBandwidthPriorityHigh')),
  };
  mock.method(
    clients,
    'sonarr',
    (() => sonarr) as unknown as typeof clients.sonarr
  );
  mock.method(
    clients,
    'radarr',
    (() => radarr) as unknown as typeof clients.radarr
  );
  mock.method(
    clients,
    'transmission',
    (() => transmission) as unknown as typeof clients.transmission
  );
  return { log, sonarr, radarr, transmission, write };
}

async function seed(type: MediaType, seasons: number[] = [1]) {
  const user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: type === MediaType.MOVIE ? 900 : 400,
      tvdbId: type === MediaType.TV ? 401 : undefined,
      mediaType: type,
      status: MediaStatus.PROCESSING,
      serviceId: 0,
      externalServiceId: type === MediaType.MOVIE ? 9 : 42,
    })
  );
  const saved = await getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      media,
      requestedBy: user,
      status: MediaRequestStatus.APPROVED,
      is4k: false,
      seasons:
        type === MediaType.TV
          ? seasons.map(
              (seasonNumber) =>
                new SeasonRequest({
                  seasonNumber,
                  status: MediaRequestStatus.APPROVED,
                })
            )
          : [],
    })
  );
  const request = await getRepository(MediaRequest).findOneOrFail({
    where: { id: saved.id },
  });
  return { request, user };
}

const act = (
  ctx: { request: MediaRequest; user: User },
  action: ItemAction,
  seasonNumber: number | null = null,
  episodeNumber: number | null = null
) =>
  runAction({
    request: ctx.request,
    user: ctx.user,
    action,
    seasonNumber,
    episodeNumber,
  });

const rows = async (requestId: number) =>
  (await getControls(requestId)).map((r) => [
    r.seasonNumber,
    r.episodeNumber,
    r.state,
  ]);

const key = (
  requestId: number,
  seasonNumber: number | null,
  episodeNumber: number | null
) => ({ requestId, seasonNumber, episodeNumber });

describe('request control actions', () => {
  let saved: {
    sonarr: SonarrSettings[];
    radarr: RadarrSettings[];
    transmission: TransmissionSettings;
  };

  beforeEach(() => {
    const settings = getSettings();
    saved = {
      sonarr: settings.sonarr,
      radarr: settings.radarr,
      transmission: settings.transmission,
    };
    settings.sonarr = [server(0)];
    settings.radarr = [server(0)];
    settings.transmission = {
      ...settings.transmission,
      enabled: true,
      hostname: 'transmission',
    };
  });

  afterEach(() => {
    const settings = getSettings();
    settings.sonarr = saved.sonarr;
    settings.radarr = saved.radarr;
    settings.transmission = saved.transmission;
    mock.restoreAll();
    stubSubscribers();
  });

  describe('prioritize', () => {
    it('searches an episode that has no torrent', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2)] });
      await act(ctx, 'prioritize', 1, 1);
      assert.deepEqual(log, [['searchEpisodes', [101]]]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('searches a whole season with nothing on disk', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2)] });
      await act(ctx, 'prioritize', 1);
      assert.deepEqual(log, [['searchSeason', 42, 1]]);
    });

    it('searches a movie that has no torrent', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({ movie: { hasFile: false } });
      await act(ctx, 'prioritize');
      assert.deepEqual(log, [['searchMovieStrict', 9]]);
    });

    it('moves a grabbed torrent to the top with high bandwidth priority', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      await act(ctx, 'prioritize', 1, 1);
      assert.deepEqual(log, [
        ['queueMoveTop', [SINGLE]],
        ['setBandwidthPriorityHigh', [SINGLE]],
      ]);
    });

    it('raises the file priority of a pack episode', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [pack()],
      });
      await act(ctx, 'prioritize', 1, 3);
      assert.deepEqual(log, [
        ['queueMoveTop', [PACK]],
        ['setBandwidthPriorityHigh', [PACK]],
        ['setFilePriorityHigh', PACK, [2]],
      ]);
    });
  });

  describe('pause', () => {
    it('unmonitors an episode and stops its own torrent', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      const state = await act(ctx, 'pause', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['stop', [SINGLE]],
      ]);
      const controls = await getControls(ctx.request.id);
      assert.equal(controls.length, 1);
      assert.equal(controls[0].state, 'paused');
      assert.equal(controls[0].pausedAtPercent, 50);
      assert.equal(state.requestId, ctx.request.id);
    });

    it('waits for the hub refresh and returns its cached state', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      const fresh = {
        requestId: ctx.request.id,
        available: true,
        updatedAt: 'fresh',
      } as RequestLiveState;
      let refreshed = false;
      const refresh = mock.method(liveStatusHub, 'refresh', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        refreshed = true;
      });
      mock.method(liveStatusHub, 'cachedState', (id: number) =>
        refreshed && id === ctx.request.id ? fresh : undefined
      );
      const state = await act(ctx, 'pause', 1, 1);
      assert.equal(refresh.mock.callCount(), 1);
      assert.equal(state, fresh);
    });

    it('returns the derived state when the hub has no cached state', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      mock.method(liveStatusHub, 'refresh', async () => undefined);
      mock.method(liveStatusHub, 'cachedState', () => undefined);
      const state = await act(ctx, 'pause', 1, 1);
      assert.equal(state.requestId, ctx.request.id);
      assert.equal(state.seasons[0].episodes[0].status, 'paused');
    });

    it('marks the files of a pack episode unwanted', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [pack()],
      });
      await act(ctx, 'pause', 1, 3);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [103], false],
        ['setFilesWanted', PACK, [2], false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 3, 'paused']]);
    });

    it('unmonitors a movie and stops its torrent', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: false },
        queue: [q(7, SINGLE, 9)],
        torrents: [
          torrent(SINGLE, [
            ['Movie.2020/Movie.2020.mkv', 1000, 250],
            ['Movie.2020/Movie.2020.nfo', 1, 1],
          ]),
        ],
      });
      await act(ctx, 'pause');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['stop', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'paused']]);
    });

    it('season pause unmonitors episodes without files, then the season', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { hasFile: true, episodeFileId: 501 }), ep(2), ep(3)],
        episodeFiles: [{ id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 }],
        queue: packQueue(),
        torrents: [pack()],
      });
      await act(ctx, 'pause', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [102, 103], false],
        ['setSeasonMonitored', 42, 1, false],
        ['stop', [PACK]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'paused']]);
    });

    it('season pause unmonitors the Sonarr season', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2)] });
      await act(ctx, 'pause', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'paused']]);
    });

    it('episode pause leaves the Sonarr season monitored', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2)] });
      await act(ctx, 'pause', 1, 2);
      assert.deepEqual(log, [['setEpisodesMonitored', [102], false]]);
    });

    it('pause on an already paused item makes no external calls', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, sonarr, transmission } = install({
        episodes: [ep(1)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      const cached = {
        requestId: ctx.request.id,
        available: true,
      } as RequestLiveState;
      mock.method(liveStatusHub, 'cachedState', (id: number) =>
        id === ctx.request.id ? cached : undefined
      );
      await setControl(key(ctx.request.id, 1, null), 'paused', ctx.user.id);
      const state = await act(ctx, 'pause', 1, 1);
      assert.equal(state, cached);
      assert.deepEqual(log, []);
      assert.equal(sonarr.getEpisodes.mock.callCount(), 0);
      assert.equal(sonarr.getEpisodeFiles.mock.callCount(), 0);
      assert.equal(sonarr.getQueueFor.mock.callCount(), 0);
      assert.equal(sonarr.getSeriesHistory.mock.callCount(), 0);
      assert.equal(transmission.getTorrents.mock.callCount(), 0);
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'paused']]);
    });

    it('pause on an already paused item without a cached state only reads', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      await setControl(key(ctx.request.id, 1, null), 'paused', ctx.user.id);
      const state = await act(ctx, 'pause', 1, 1);
      assert.deepEqual(log, []);
      assert.equal(state.seasons[0].episodes[0].status, 'paused');
    });

    it('transmission failure during pause throws ServiceError and leaves no control row', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, transmission, write } = install({
        episodes: [ep(1)],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 50]])],
      });
      transmission.stop.mock.mockImplementation(
        write('stop', () => new Error('connect ECONNREFUSED'))
      );
      await assert.rejects(
        act(ctx, 'pause', 1, 1),
        (e: unknown) =>
          e instanceof ServiceError &&
          e.service === 'transmission' &&
          /ECONNREFUSED/.test(e.message)
      );
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['stop', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('sonarr unavailable rejects with ServiceError before any change', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, sonarr } = install({ episodes: [ep(1)] });
      sonarr.getEpisodes.mock.mockImplementation(async () => {
        throw new Error('timeout');
      });
      await assert.rejects(
        act(ctx, 'pause', 1, 1),
        (e: unknown) => e instanceof ServiceError && e.service === 'sonarr'
      );
      assert.deepEqual(log, []);
      assert.deepEqual(await rows(ctx.request.id), []);
    });
  });

  describe('resume', () => {
    it('re-monitors and re-wants the files of a paused pack episode', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [
          torrent(PACK, [
            ['Show.S01E01.mkv', 1000, 1000],
            ['Show.S01E02.mkv', 1000, 1000],
            ['Show.S01E03.mkv', 1000, 400, false],
          ]),
        ],
      });
      await setControl(key(ctx.request.id, 1, 3), 'paused', ctx.user.id, 40);
      await act(ctx, 'resume', 1, 3);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [103], true],
        ['setFilesWanted', PACK, [2], true],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('restarts a stopped torrent wholly covered by the item', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: false, monitored: false },
        queue: [q(7, SINGLE, 9)],
        torrents: [
          torrent(SINGLE, [['Movie.2020.mkv', 1000, 250]], { status: 0 }),
        ],
      });
      await setControl(key(ctx.request.id, null, null), 'paused', ctx.user.id);
      await act(ctx, 'resume');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, true],
        ['start', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('resume falls back to search when the torrent no longer exists', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { monitored: false }), ep(2)],
        queue: [q(1, SINGLE, 101)],
        torrents: [],
      });
      await setControl(key(ctx.request.id, 1, 1), 'paused', ctx.user.id, 30);
      await act(ctx, 'resume', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], true],
        ['searchEpisodes', [101]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('resuming one episode of a paused season keeps the others paused', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2)] });
      await setControl(key(ctx.request.id, 1, null), 'paused', ctx.user.id);
      await act(ctx, 'resume', 1, 2);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [102], true],
        ['searchEpisodes', [102]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 1, 'paused']]);
    });

    it('season resume re-monitors the season then unmonitors still-held episodes', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { monitored: false }),
          ep(2, { monitored: false }),
          ep(3, { monitored: false }),
        ],
      });
      await setControl(key(ctx.request.id, 1, null), 'paused', ctx.user.id);
      await setControl(key(ctx.request.id, 1, 3), 'deleted', ctx.user.id);
      await act(ctx, 'resume', 1);
      assert.deepEqual(log, [
        ['setSeasonMonitored', 42, 1, true],
        ['setEpisodesMonitored', [101, 102], true],
        ['setEpisodesMonitored', [103], false],
        ['searchEpisodes', [101, 102]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 3, 'deleted']]);
    });

    it('resume on an item with no control makes no external calls', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1)] });
      await act(ctx, 'resume', 1, 1);
      assert.deepEqual(log, []);
    });

    it('prioritize on a paused item is rejected', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1)] });
      await setControl(key(ctx.request.id, 1, 1), 'paused', ctx.user.id);
      await assert.rejects(
        act(ctx, 'prioritize', 1, 1),
        (e: unknown) => e instanceof ActionError && e.status === 400
      );
      assert.deepEqual(log, []);
    });
  });

  describe('delete', () => {
    it('removes a wholly covered torrent with its data and deletes the imported file', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { hasFile: true, episodeFileId: 500 }), ep(2)],
        episodeFiles: [{ id: 500, path: '/tv/Show/S01E01.mkv', size: 100 }],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 100]])],
      });
      await act(ctx, 'delete', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['sonarr.removeQueueItems', [1], true],
        ['deleteEpisodeFiles', [500]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 1, 'deleted']]);
    });

    it('marks the files of a pack episode unwanted and deletes its library file', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, transmission } = install({
        episodes: [ep(1), ep(2, { hasFile: true, episodeFileId: 502 }), ep(3)],
        episodeFiles: [{ id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 }],
        queue: packQueue(),
        torrents: [pack()],
      });
      await act(ctx, 'delete', 1, 2);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [102], false],
        ['setFilesWanted', PACK, [1], false],
        ['deleteEpisodeFiles', [502]],
      ]);
      assert.equal(transmission.remove.mock.callCount(), 0);
      assert.deepEqual(await rows(ctx.request.id), [[1, 2, 'deleted']]);
    });

    it('request-level delete unmonitors every requested season', async () => {
      const ctx = await seed(MediaType.TV, [1, 2]);
      const { log } = install({
        episodes: [
          ep(1),
          ep(2),
          ep(1, { id: 201, seasonNumber: 2 }),
          ep(2, { id: 202, seasonNumber: 2 }),
        ],
      });
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102, 201, 202], false],
        ['setSeasonMonitored', 42, 1, false],
        ['setSeasonMonitored', 42, 2, false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'deleted']]);
    });

    it('season restore re-monitors the Sonarr season', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { monitored: false }), ep(2, { monitored: false })],
      });
      await setControl(key(ctx.request.id, 1, null), 'deleted', ctx.user.id);
      await act(ctx, 'restore', 1);
      assert.deepEqual(log, [
        ['setSeasonMonitored', 42, 1, true],
        ['setEpisodesMonitored', [101, 102], true],
        ['searchSeason', 42, 1],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('deletes a movie with its torrent and movie file', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: true },
        movieFiles: [{ id: 900, path: '/movies/Movie.2020.mkv', size: 1000 }],
        queue: [q(7, SINGLE, 9)],
        torrents: [torrent(SINGLE, [['Movie.2020.mkv', 1000, 1000]])],
      });
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['radarr.removeQueueItems', [7], true],
        ['deleteMovieFile', 900],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'deleted']]);
    });

    it('episode delete in a pack whose other files are unmappable does not remove the torrent', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, transmission } = install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101), q(2, SINGLE, 102)],
        torrents: [
          torrent(SINGLE, [
            ['Show/Show.S01E01.mkv', 1000, 500],
            ['Show/Show.Part.Two.mkv', 1000, 500],
          ]),
        ],
      });
      await act(ctx, 'delete', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['setFilesWanted', SINGLE, [0], false],
      ]);
      assert.equal(transmission.remove.mock.callCount(), 0);
    });

    it('episode delete of a torrent tied only to that episode removes it despite unmappable names', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101)],
        torrents: [
          torrent(SINGLE, [
            ['Show/Show.S01E01.mkv', 1000, 500],
            ['Show/Show.Part.Two.mkv', 1000, 500],
          ]),
        ],
      });
      await act(ctx, 'delete', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['sonarr.removeQueueItems', [1], true],
      ]);
    });

    it('delete of S01E01 whose file is S01E01E02 deletes the file and reports both episodes in preview', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 600 }),
          ep(2, { hasFile: true, episodeFileId: 600 }),
          ep(3),
        ],
        episodeFiles: [
          { id: 600, path: '/tv/Show/Show.S01E01E02.mkv', size: 2000 },
        ],
      });
      const preview = await getDeletePreview(ctx.request, 1, 1);
      assert.deepEqual(preview, {
        files: [
          {
            path: '/tv/Show/Show.S01E01E02.mkv',
            bytes: 2000,
            freedBytes: 2000,
            episodes: ['S01E01', 'S01E02'],
          },
        ],
        bytesFreed: 2000,
        torrentKept: false,
      });
      assert.deepEqual(log, []);
      await act(ctx, 'delete', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['deleteEpisodeFiles', [600]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [
        [1, 1, 'deleted'],
        [1, 2, 'deleted'],
      ]);
    });

    it('preview reports bytesFreed 0 and torrentKept true for a pack episode still seeding', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [ep(1), ep(2, { hasFile: true, episodeFileId: 502 }), ep(3)],
        episodeFiles: [{ id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 }],
        queue: packQueue(),
        torrents: [pack()],
      });
      const preview = await getDeletePreview(ctx.request, 1, 2);
      assert.deepEqual(preview, {
        files: [
          {
            path: '/tv/Show/S01E02.mkv',
            bytes: 1000,
            freedBytes: 0,
            episodes: ['S01E02'],
          },
        ],
        bytesFreed: 0,
        torrentKept: true,
      });
    });

    it('preview reports freedBytes 0 for a hardlinked file kept by a seeding pack and its size otherwise', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(3),
        ],
        episodeFiles: [
          { id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 },
          { id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 },
        ],
        history: grabbed(PACK, 102),
        torrents: [
          torrent(
            PACK,
            [
              ['Show/Show.S01E02.mkv', 1000, 1000],
              ['Show/Show.S02E01.mkv', 1000, 1000],
            ],
            { status: 6 }
          ),
        ],
      });
      const preview = await getDeletePreview(ctx.request, 1, null);
      assert.equal(preview.torrentKept, true);
      const byPath = Object.fromEntries(
        preview.files.map((f) => [f.path, f.freedBytes])
      );
      assert.equal(byPath['/tv/Show/S01E01.mkv'], 1000);
      assert.equal(byPath['/tv/Show/S01E02.mkv'], 0);
      assert.equal(
        preview.bytesFreed,
        preview.files.reduce((sum, f) => sum + f.freedBytes, 0)
      );
    });

    it('preview of a season counts library files and torrent data without a library copy', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [ep(1, { hasFile: true, episodeFileId: 501 }), ep(2), ep(3)],
        episodeFiles: [{ id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 }],
        queue: packQueue(),
        torrents: [pack()],
      });
      const preview = await getDeletePreview(ctx.request, 1, null);
      assert.equal(preview.bytesFreed, 1000 + 1000 + 400);
      assert.equal(preview.torrentKept, false);
      assert.deepEqual(
        preview.files.map((f) => [f.bytes, f.episodes]),
        [
          [1000, ['S01E01']],
          [1000, ['S01E02']],
          [400, ['S01E03']],
        ]
      );
    });

    it('concurrent delete calls on the same episode make one set of external calls', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { hasFile: true, episodeFileId: 500 })],
        episodeFiles: [{ id: 500, path: '/tv/Show/S01E01.mkv', size: 100 }],
        queue: [q(1, SINGLE, 101)],
        torrents: [torrent(SINGLE, [['Show.S01E01.mkv', 100, 100]])],
      });
      const results = await Promise.all([
        act(ctx, 'delete', 1, 1),
        act(ctx, 'delete', 1, 1),
      ]);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['sonarr.removeQueueItems', [1], true],
        ['deleteEpisodeFiles', [500]],
      ]);
      assert.equal(results.length, 2);
      assert.deepEqual(await rows(ctx.request.id), [[1, 1, 'deleted']]);
    });
  });

  describe('restore', () => {
    it('re-monitors, searches and clears the deleted marker', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { monitored: false }), ep(2)],
      });
      await setControl(key(ctx.request.id, 1, 1), 'deleted', ctx.user.id);
      await act(ctx, 'restore', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], true],
        ['searchEpisodes', [101]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('restores a deleted movie', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({ movie: { hasFile: false, monitored: false } });
      await setControl(key(ctx.request.id, null, null), 'deleted', ctx.user.id);
      await act(ctx, 'restore');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, true],
        ['searchMovieStrict', 9],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('movie restore returns 502 when the radarr search fails', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { radarr, write } = install({
        movie: { hasFile: false, monitored: false },
      });
      radarr.searchMovieStrict.mock.mockImplementation(
        write('searchMovieStrict', () => new Error('Radarr search failed'))
      );
      await setControl(key(ctx.request.id, null, null), 'deleted', ctx.user.id);
      await assert.rejects(
        act(ctx, 'restore'),
        (e: unknown) => e instanceof ServiceError && e.service === 'radarr'
      );
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'deleted']]);
    });
  });

  describe('torrents found through history', () => {
    it('delete of an imported season removes the seeding torrent found via history', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(3, { hasFile: true, episodeFileId: 503 }),
        ],
        episodeFiles: [
          { id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 },
          { id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 },
          { id: 503, path: '/tv/Show/S01E03.mkv', size: 1000 },
        ],
        history: grabbed(PACK.toUpperCase(), 101, 102, 103),
        torrents: [pack({ status: 6 })],
      });
      await act(ctx, 'delete', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102, 103], false],
        ['setSeasonMonitored', 42, 1, false],
        ['remove', [PACK], true],
        ['deleteEpisodeFiles', [501, 502, 503]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'deleted']]);
    });

    it('preview of an imported pack episode still seeding reports bytesFreed 0 and torrentKept true without a queue record', async () => {
      const ctx = await seed(MediaType.TV);
      install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(3, { hasFile: true, episodeFileId: 503 }),
        ],
        episodeFiles: [
          { id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 },
          { id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 },
          { id: 503, path: '/tv/Show/S01E03.mkv', size: 1000 },
        ],
        history: grabbed(PACK, 101, 102, 103),
        torrents: [pack({ status: 6 })],
      });
      const preview = await getDeletePreview(ctx.request, 1, 2);
      assert.deepEqual(preview, {
        files: [
          {
            path: '/tv/Show/S01E02.mkv',
            bytes: 1000,
            freedBytes: 0,
            episodes: ['S01E02'],
          },
        ],
        bytesFreed: 0,
        torrentKept: true,
      });
    });

    it('movie delete removes the seeding movie torrent found via history', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: true },
        movieFiles: [{ id: 900, path: '/movies/Movie.2020.mkv', size: 1000 }],
        history: [
          { movieId: 9, downloadId: SINGLE, eventType: 'grabbed' },
          { movieId: 9, downloadId: PACK, eventType: 'downloadFailed' },
        ],
        torrents: [
          torrent(SINGLE, [['Movie.2020.mkv', 1000, 1000]], { status: 6 }),
          torrent(PACK, [['Other.mkv', 1000, 1000]], { status: 6 }),
        ],
      });
      const preview = await getDeletePreview(ctx.request, null, null);
      assert.equal(preview.bytesFreed, 1000);
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['remove', [SINGLE], true],
        ['deleteMovieFile', 900],
      ]);
    });

    const unnamedPack = () =>
      torrent(PACK, [
        ['Show.Complete/01.mkv', 1000, 1000],
        ['Show.Complete/02.mkv', 1000, 1000],
        ['Show.Complete/info.nfo', 1, 1],
      ]);

    it('season delete removes a pack with unmappable names when history ties it only to that season', async () => {
      const ctx = await seed(MediaType.TV, [1, 2]);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(1, { id: 201, seasonNumber: 2 }),
        ],
        history: grabbed(PACK, 101, 102),
        torrents: [unnamedPack()],
      });
      await act(ctx, 'delete', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
        ['remove', [PACK], true],
        ['deleteEpisodeFiles', [501, 502]],
      ]);
    });

    it('season delete keeps a pack with unmappable names and no history', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
        ],
        queue: [{ ...q(11, PACK, 101), episodeId: undefined }],
        torrents: [unnamedPack()],
      });
      await act(ctx, 'delete', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
        ['deleteEpisodeFiles', [501, 502]],
      ]);
    });

    it('season delete keeps a pack whose history includes another season', async () => {
      const ctx = await seed(MediaType.TV, [1, 2]);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(1, {
            id: 201,
            seasonNumber: 2,
            hasFile: true,
            episodeFileId: 601,
          }),
        ],
        history: grabbed(PACK, 101, 102, 201),
        torrents: [unnamedPack()],
      });
      await act(ctx, 'delete', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
        ['deleteEpisodeFiles', [501, 502]],
      ]);
    });
  });

  describe('restore with a kept torrent Sonarr no longer tracks', () => {
    it('re-wants the file and still searches', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { monitored: false }),
          ep(3, { hasFile: true, episodeFileId: 503 }),
        ],
        history: grabbed(PACK, 101, 102, 103),
        torrents: [
          torrent(
            PACK,
            [
              ['Show.S01/Show.S01E01.mkv', 1000, 1000],
              ['Show.S01/Show.S01E02.mkv', 1000, 1000, false],
              ['Show.S01/Show.S01E03.mkv', 1000, 1000],
            ],
            { status: 6 }
          ),
        ],
      });
      await setControl(key(ctx.request.id, 1, 2), 'deleted', ctx.user.id);
      await act(ctx, 'restore', 1, 2);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [102], true],
        ['setFilesWanted', PACK, [1], true],
        ['searchEpisodes', [102]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });
  });

  describe('deleted children under a paused parent', () => {
    it('Pause S1 then Delete E3 then Resume S1 keeps E3 deleted, unmonitored, files unwanted and unsearched', async () => {
      const ctx = await seed(MediaType.TV);
      const world: World = {
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [pack()],
      };
      const { log } = install(world);

      await act(ctx, 'pause', 1);
      assert.deepEqual(log.splice(0), [
        ['setEpisodesMonitored', [101, 102, 103], false],
        ['setSeasonMonitored', 42, 1, false],
        ['stop', [PACK]],
      ]);
      world.episodes = world.episodes?.map((e) => ({ ...e, monitored: false }));
      world.torrents = [pack({ status: 0 })];

      await act(ctx, 'delete', 1, 3);
      assert.deepEqual(log.splice(0), [
        ['setEpisodesMonitored', [103], false],
        ['setFilesWanted', PACK, [2], false],
      ]);
      world.torrents = [
        torrent(
          PACK,
          [
            ['Show.S01/Show.S01E01.mkv', 1000, 1000],
            ['Show.S01/Show.S01E02.mkv', 1000, 1000],
            ['Show.S01/Show.S01E03.mkv', 1000, 400, false],
          ],
          { status: 0 }
        ),
      ];

      await act(ctx, 'resume', 1);
      assert.deepEqual(log, [
        ['setSeasonMonitored', 42, 1, true],
        ['setEpisodesMonitored', [101, 102], true],
        ['setEpisodesMonitored', [103], false],
        ['start', [PACK]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 3, 'deleted']]);
    });

    it('Delete E3 then Pause S1 keeps the E3 deleted row', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({ episodes: [ep(1), ep(2), ep(3)] });
      await act(ctx, 'delete', 1, 3);
      log.splice(0);
      await act(ctx, 'pause', 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [
        [1, 3, 'deleted'],
        [1, null, 'paused'],
      ]);
    });

    it('request pause over a deleted season keeps the season deleted, and resume leaves it alone', async () => {
      const ctx = await seed(MediaType.TV, [1, 2]);
      const { log } = install({
        episodes: [
          ep(1),
          ep(2),
          ep(1, { id: 201, seasonNumber: 2 }),
          ep(2, { id: 202, seasonNumber: 2 }),
        ],
      });
      await act(ctx, 'delete', 2);
      log.splice(0);
      await act(ctx, 'pause');
      assert.deepEqual(log.splice(0), [
        ['setEpisodesMonitored', [101, 102], false],
        ['setSeasonMonitored', 42, 1, false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [
        [2, null, 'deleted'],
        [null, null, 'paused'],
      ]);
      await act(ctx, 'resume');
      assert.deepEqual(log, [
        ['setSeasonMonitored', 42, 1, true],
        ['setEpisodesMonitored', [101, 102], true],
        ['searchSeason', 42, 1],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[2, null, 'deleted']]);
    });
  });

  describe('source failures and multi-episode files', () => {
    it('prioritize with transmission down and no torrent hashes searches and returns 200', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, transmission } = install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 102)],
      });
      transmission.getTorrents.mock.mockImplementation(async () => {
        throw new Error('connect ECONNREFUSED');
      });
      const state = await act(ctx, 'prioritize', 1, 1);
      assert.deepEqual(log, [['searchEpisodes', [101]]]);
      assert.equal(state.available, false);
    });

    it('an action on an item with torrents fails when transmission is down', async () => {
      const ctx = await seed(MediaType.TV);
      const { log, transmission } = install({
        episodes: [ep(1)],
        queue: [q(1, SINGLE, 101)],
      });
      transmission.getTorrents.mock.mockImplementation(async () => {
        throw new Error('connect ECONNREFUSED');
      });
      await assert.rejects(
        act(ctx, 'pause', 1, 1),
        (e: unknown) =>
          e instanceof ServiceError && e.service === 'transmission'
      );
      assert.deepEqual(log, []);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('pausing S01E01 of a S01E01E02 file pauses both episodes', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: [q(1, SINGLE, 101), q(2, SINGLE, 102)],
        torrents: [torrent(SINGLE, [['Show.S01E01E02.mkv', 2000, 500]])],
      });
      await act(ctx, 'pause', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101, 102], false],
        ['stop', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [
        [1, 1, 'paused'],
        [1, 2, 'paused'],
      ]);
    });

    it('prioritizing S01E01 of a S01E01E02 file inside a pack raises the shared file', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [
          torrent(PACK, [
            ['Show.S01/Show.S01E01E02.mkv', 2000, 500],
            ['Show.S01/Show.S01E03.mkv', 1000, 500],
          ]),
        ],
      });
      await act(ctx, 'prioritize', 1, 1);
      assert.deepEqual(log, [
        ['queueMoveTop', [PACK]],
        ['setBandwidthPriorityHigh', [PACK]],
        ['setFilePriorityHigh', PACK, [0]],
      ]);
    });
  });

  describe('expansion and pack safety', () => {
    const multi = (status: TorrentInfo['status'] = 4) =>
      torrent(SINGLE, [['Show.S01E01E02.mkv', 2000, 500]], { status });

    it('delete E1 does not expand to E2 through a history-only multi-episode torrent when E2 has its own file', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [
          ep(1, { hasFile: true, episodeFileId: 501 }),
          ep(2, { hasFile: true, episodeFileId: 502 }),
          ep(3),
        ],
        episodeFiles: [
          { id: 501, path: '/tv/Show/S01E01.mkv', size: 1000 },
          { id: 502, path: '/tv/Show/S01E02.mkv', size: 1000 },
        ],
        history: grabbed(SINGLE, 101, 102),
        torrents: [multi(6)],
      });
      const preview = await getDeletePreview(ctx.request, 1, 1);
      assert.deepEqual(
        preview.files.map((f) => f.episodes),
        [['S01E01']]
      );
      await act(ctx, 'delete', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['setFilesWanted', SINGLE, [0], false],
        ['deleteEpisodeFiles', [501]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 1, 'deleted']]);
    });

    it('pause expansion skips a deleted sibling', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2)],
        queue: [q(1, SINGLE, 101), q(2, SINGLE, 102)],
        torrents: [multi()],
      });
      await setControl(key(ctx.request.id, 1, 2), 'deleted', ctx.user.id);
      await act(ctx, 'pause', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['stop', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [
        [1, 2, 'deleted'],
        [1, 1, 'paused'],
      ]);
    });

    it('resume expansion keeps a deleted sibling deleted', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1, { monitored: false }), ep(2, { monitored: false })],
        queue: [q(1, SINGLE, 101), q(2, SINGLE, 102)],
        torrents: [multi(0)],
      });
      await setControl(key(ctx.request.id, 1, 2), 'deleted', ctx.user.id);
      await setControl(key(ctx.request.id, 1, 1), 'paused', ctx.user.id);
      await act(ctx, 'resume', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], true],
        ['start', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 2, 'deleted']]);
    });

    it('pause expansion writes no paused row for a sibling with a file', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2, { hasFile: true, episodeFileId: 502 })],
        queue: [q(1, SINGLE, 101), q(2, SINGLE, 102)],
        torrents: [multi()],
      });
      await act(ctx, 'pause', 1, 1);
      assert.deepEqual(log, [
        ['setEpisodesMonitored', [101], false],
        ['setFilesWanted', SINGLE, [0], false],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, 1, 'paused']]);
    });

    it('movie delete keeps a multi-movie pack torrent and reports torrentKept', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: true },
        movieFiles: [{ id: 900, path: '/movies/Movie.2.mkv', size: 1000 }],
        history: [{ movieId: 9, downloadId: PACK, eventType: 'grabbed' }],
        torrents: [
          torrent(
            PACK,
            [
              ['Trilogy/Movie.1.mkv', 1000, 1000],
              ['Trilogy/Movie.2.mkv', 1000, 1000],
              ['Trilogy/Movie.3.mkv', 1000, 1000],
              ['Trilogy/Movie.2.sample.mkv', 10, 10],
              ['Trilogy/info.nfo', 1, 1],
            ],
            { status: 6 }
          ),
        ],
      });
      const preview = await getDeletePreview(ctx.request, null, null);
      assert.deepEqual(preview, {
        files: [
          {
            path: '/movies/Movie.2.mkv',
            bytes: 1000,
            freedBytes: 0,
            episodes: [],
          },
        ],
        bytesFreed: 0,
        torrentKept: true,
      });
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['deleteMovieFile', 900],
      ]);
    });

    it('movie pause stops a queue-tracked torrent that also holds an extras file', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: false },
        queue: [q(7, SINGLE, 9)],
        torrents: [
          torrent(SINGLE, [
            ['Movie.2020/Movie.2020.mkv', 1000, 250],
            ['Movie.2020/Extras/Behind.The.Scenes.mkv', 200, 50],
          ]),
        ],
      });
      await act(ctx, 'pause');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['stop', [SINGLE]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'paused']]);
    });

    it('movie delete removes a queue-tracked torrent with extras', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: false },
        queue: [q(7, SINGLE, 9)],
        torrents: [
          torrent(SINGLE, [
            ['Movie.2020/Movie.2020.mkv', 1000, 250],
            ['Movie.2020/Extras/Behind.The.Scenes.mkv', 200, 50],
          ]),
        ],
      });
      const preview = await getDeletePreview(ctx.request, null, null);
      assert.equal(preview.torrentKept, false);
      assert.equal(preview.bytesFreed, 300);
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['radarr.removeQueueItems', [7], true],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[null, null, 'deleted']]);
    });

    it('episode pause inside an unmappable tracked pack returns 409', async () => {
      const ctx = await seed(MediaType.TV);
      const { log } = install({
        episodes: [ep(1), ep(2), ep(3)],
        queue: packQueue(),
        torrents: [
          torrent(PACK, [
            ['Show.Season.1/part1.mkv', 1000, 500],
            ['Show.Season.1/part2.mkv', 1000, 500],
            ['Show.Season.1/part3.mkv', 1000, 500],
          ]),
        ],
      });
      const packError = (e: unknown) =>
        e instanceof ActionError &&
        e.status === 409 &&
        e.message ===
          'This episode is inside a season pack whose files cannot be told apart. Pause or delete the whole season instead.';
      await assert.rejects(act(ctx, 'pause', 1, 2), packError);
      await assert.rejects(act(ctx, 'delete', 1, 2), packError);
      await assert.rejects(getDeletePreview(ctx.request, 1, 2), packError);
      assert.deepEqual(log, []);
      assert.deepEqual(await rows(ctx.request.id), []);
    });

    it('movie delete removes a single-movie torrent with sample and extras', async () => {
      const ctx = await seed(MediaType.MOVIE);
      const { log } = install({
        movie: { hasFile: true },
        movieFiles: [{ id: 900, path: '/movies/Movie.mkv', size: 1000 }],
        history: [{ movieId: 9, downloadId: PACK, eventType: 'grabbed' }],
        torrents: [
          torrent(
            PACK,
            [
              ['Movie/Movie.mkv', 1000, 1000],
              ['Movie/Sample/Movie.sample.mkv', 10, 10],
              ['Movie/Movie.nfo', 1, 1],
            ],
            { status: 6 }
          ),
        ],
      });
      await act(ctx, 'delete');
      assert.deepEqual(log, [
        ['setMovieMonitored', 9, false],
        ['remove', [PACK], true],
        ['deleteMovieFile', 900],
      ]);
    });
  });
});
