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
import { clients } from '@server/lib/liveStatus/sources';
import type { ItemAction } from '@server/lib/liveStatus/types';
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
};

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
      (world.queue ?? []).filter((r) => r.episodeId !== undefined)
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
    getCommands: mock.fn(async () => []),
    setMovieMonitored: mock.fn(write('setMovieMonitored')),
    searchMovie: mock.fn(write('searchMovie')),
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
      assert.deepEqual(log, [['searchMovie', 9]]);
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

    it('season pause leaves episodes with files monitored', async () => {
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
        ['stop', [PACK]],
      ]);
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'paused']]);
    });

    it('pause on an already paused item makes no external calls', async () => {
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
      assert.deepEqual(await rows(ctx.request.id), [[1, null, 'paused']]);
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
        ['setFilesWanted', SINGLE, [0], false],
      ]);
      assert.equal(transmission.remove.mock.callCount(), 0);
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
          { path: '/tv/Show/S01E02.mkv', bytes: 1000, episodes: ['S01E02'] },
        ],
        bytesFreed: 0,
        torrentKept: true,
      });
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
        ['searchMovie', 9],
      ]);
      assert.deepEqual(await rows(ctx.request.id), []);
    });
  });
});
