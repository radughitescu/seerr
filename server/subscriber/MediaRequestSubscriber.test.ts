import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { setControl } from '@server/lib/requestControls/store';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import {
  EPISODE_POLL_MS,
  EPISODE_WAIT_MS,
  MediaRequestSubscriber,
} from './MediaRequestSubscriber';

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => undefined);

const tmdbCalls: string[] = [];

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) => {
      tmdbCalls.push(`tv:${tvId}`);
      return {
        id: tvId,
        name: 'Show',
        keywords: { results: [] },
        external_ids: {},
      } as unknown as TmdbTvDetails;
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => {
      tmdbCalls.push(`movie:${movieId}`);
      return {
        id: movieId,
        title: 'Movie',
        release_date: '2020-01-01',
      } as unknown as TmdbMovieDetails;
    };
  },
  set() {},
  configurable: true,
});

type Episode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  hasFile: boolean;
  monitored: boolean;
  airDateUtc: string;
};

type Call = { service: string; method: string; url: string; data?: unknown };

type World = {
  inLibrary?: boolean;
  episodes?: Episode[];
  emptyEpisodeCalls?: number;
  failMonitorCalls?: number;
};

const AIRED = '2020-01-01T00:00:00Z';

const episode = (
  seasonNumber: number,
  episodeNumber: number,
  over: Partial<Episode> = {}
): Episode => ({
  id: seasonNumber * 100 + episodeNumber,
  seasonNumber,
  episodeNumber,
  hasFile: false,
  monitored: false,
  airDateUtc: AIRED,
  ...over,
});

function installServarr(world: World) {
  const calls: Call[] = [];
  const original = axios.create;
  const fake = (service: string) => {
    const record = (method: string) => async (url: string, data?: unknown) => {
      calls.push({
        service,
        method,
        url,
        data: method === 'get' ? (data as { params?: unknown })?.params : data,
      });
      if (method === 'get' && url === '/series/lookup') {
        return {
          data: [
            world.inLibrary === false
              ? {
                  title: 'Show',
                  seasons: [1, 2].map((seasonNumber) => ({
                    seasonNumber,
                    monitored: false,
                  })),
                }
              : {
                  id: 7,
                  title: 'Show',
                  titleSlug: 'show',
                  tags: [],
                  monitored: true,
                  seasons: [1, 2].map((seasonNumber) => ({
                    seasonNumber,
                    monitored: false,
                  })),
                },
          ],
        };
      }
      if (method === 'get' && url === '/episode') {
        if (world.emptyEpisodeCalls) {
          world.emptyEpisodeCalls--;
          return { data: [] };
        }
        return { data: world.episodes ?? [] };
      }
      if (
        method === 'put' &&
        url === '/episode/monitor' &&
        world.failMonitorCalls
      ) {
        world.failMonitorCalls--;
        throw new Error('Sonarr is unreachable');
      }
      if ((method === 'put' || method === 'post') && url === '/series') {
        return {
          data: { ...(data as object), id: 7, titleSlug: 'show' },
        };
      }
      if (method === 'post' && url === '/movie') {
        return { data: { ...(data as object), id: 9, titleSlug: 'movie' } };
      }
      if (method === 'get' && url === '/movie/lookup') {
        return { data: [{ title: 'Movie', tags: [] }] };
      }
      return { data: [] };
    };
    return {
      interceptors: {
        request: { use: () => 0 },
        response: { use: () => 0 },
      },
      defaults: { headers: {} },
      get: record('get'),
      put: record('put'),
      post: record('post'),
      delete: record('delete'),
    };
  };
  mock.method(axios, 'create', (config?: { baseURL?: string }) => {
    if (config?.baseURL?.includes(':8989')) return fake('sonarr');
    if (config?.baseURL?.includes(':7878')) return fake('radarr');
    return original(config);
  });
  return calls;
}

const settle = async () => {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function configureServers() {
  const settings = getSettings();
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'localhost',
      port: 8989,
      apiKey: 'key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      animeTags: [],
      is4k: false,
      enableSeasonFolders: true,
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
    } as unknown as SonarrSettings,
  ];
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      externalUrl: '',
    } as unknown as RadarrSettings,
  ];
}

let nextTmdbId = 500;

async function seed(type: MediaType, seasons: number[] = []) {
  const user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
  const tmdbId = nextTmdbId++;
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      tvdbId: type === MediaType.TV ? tmdbId + 1000 : undefined,
      mediaType: type,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const saved = await getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      media,
      requestedBy: user,
      status: MediaRequestStatus.PENDING,
      is4k: false,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
  const request = await getRepository(MediaRequest).findOneOrFail({
    where: { id: saved.id },
  });
  request.status = MediaRequestStatus.APPROVED;
  return { request, user };
}

const subscriber = new MediaRequestSubscriber();

const send = async (request: MediaRequest) => {
  if (request.type === MediaType.TV) {
    await subscriber.sendToSonarr(request, dataSource.manager);
  } else {
    await subscriber.sendToRadarr(request, dataSource.manager);
  }
  await settle();
};

const commands = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'post' && c.url === '/command')
    .map((c) => c.data as { name: string; [key: string]: unknown });

const seriesPut = (calls: Call[]) =>
  calls.find((c) => c.method === 'put' && c.url === '/series')?.data as
    | { seasons: { seasonNumber: number; monitored: boolean }[] }
    | undefined;

const newSeries = (calls: Call[]) =>
  calls.find((c) => c.method === 'post' && c.url === '/series')?.data as
    | {
        seasons: { seasonNumber: number; monitored: boolean }[];
        addOptions: { searchForMissingEpisodes: boolean };
      }
    | undefined;

const monitorCalls = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'put' && c.url === '/episode/monitor')
    .map((c) => c.data as { episodeIds: number[]; monitored: boolean });

describe('MediaRequestSubscriber guards for paused and deleted items', () => {
  beforeEach(() => {
    configureServers();
    tmdbCalls.length = 0;
  });

  afterEach(() => {
    mock.restoreAll();
    mock.method(MediaRequest, 'sendNotification', async () => undefined);
  });

  it('sendToSonarr omits a deleted season and triggers no search when all seasons are blocked', async () => {
    const calls = installServarr({
      episodes: [episode(1, 1), episode(2, 1)],
    });
    const partly = await seed(MediaType.TV, [1, 2]);
    await setControl(
      { requestId: partly.request.id, seasonNumber: 2, episodeNumber: null },
      'deleted',
      partly.user.id
    );

    await send(partly.request);

    const put = seriesPut(calls);
    assert.ok(put, 'the series is updated for the season that is not blocked');
    assert.deepStrictEqual(
      put.seasons.map((s) => [s.seasonNumber, s.monitored]),
      [
        [1, true],
        [2, false],
      ]
    );
    assert.ok(
      monitorCalls(calls)
        .filter((c) => c.monitored)
        .every((c) => c.episodeIds.every((id) => id < 200)),
      'no episode of the deleted season is monitored'
    );

    calls.length = 0;
    const blocked = await seed(MediaType.TV, [1, 2]);
    await setControl(
      { requestId: blocked.request.id, seasonNumber: 1, episodeNumber: null },
      'deleted',
      blocked.user.id
    );
    await setControl(
      { requestId: blocked.request.id, seasonNumber: 2, episodeNumber: null },
      'paused',
      blocked.user.id
    );
    tmdbCalls.length = 0;

    await send(blocked.request);

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(tmdbCalls, []);
    const persisted = await getRepository(MediaRequest).findOneOrFail({
      where: { id: blocked.request.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sendToSonarr sends nothing for a request-level paused row', async () => {
    const calls = installServarr({ episodes: [episode(1, 1)] });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: null, episodeNumber: null },
      'paused',
      ctx.user.id
    );

    await send(ctx.request);

    assert.deepStrictEqual(calls, []);
  });

  it('sendToSonarr unmonitors an episode-level paused row after update', async () => {
    const calls = installServarr({
      episodes: [
        episode(1, 1, { monitored: true }),
        episode(1, 2, { monitored: true }),
        episode(1, 3, { monitored: true }),
      ],
    });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 1, episodeNumber: 3 },
      'paused',
      ctx.user.id
    );

    await send(ctx.request);

    const putIndex = calls.findIndex(
      (c) => c.method === 'put' && c.url === '/series'
    );
    const unmonitorIndex = calls.findIndex(
      (c) =>
        c.method === 'put' &&
        c.url === '/episode/monitor' &&
        (c.data as { monitored: boolean }).monitored === false
    );
    assert.ok(putIndex >= 0);
    assert.ok(unmonitorIndex > putIndex, 'unmonitor runs after the update');
    assert.deepStrictEqual(calls[unmonitorIndex].data, {
      episodeIds: [103],
      monitored: false,
    });
    const searched = commands(calls);
    assert.ok(
      searched.every((c) => c.name === 'EpisodeSearch'),
      `no series-wide search: ${JSON.stringify(searched)}`
    );
    assert.deepStrictEqual(
      searched.flatMap((c) => c.episodeIds as number[]),
      [101, 102]
    );
  });

  it('sendToSonarr with partly blocked seasons searches only unblocked seasons', async () => {
    const calls = installServarr({
      episodes: [
        episode(1, 1),
        episode(1, 2, { hasFile: true }),
        episode(1, 3, { airDateUtc: '2999-01-01T00:00:00Z' }),
        episode(2, 1),
        episode(2, 2),
      ],
    });
    const ctx = await seed(MediaType.TV, [1, 2]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 2, episodeNumber: null },
      'paused',
      ctx.user.id
    );

    await send(ctx.request);

    assert.deepStrictEqual(commands(calls), [
      { name: 'EpisodeSearch', episodeIds: [101] },
    ]);
  });

  it('sendToSonarr adds a new series with a season-level block using its own search', async () => {
    const calls = installServarr({
      inLibrary: false,
      episodes: [episode(1, 1), episode(2, 1)],
    });
    const ctx = await seed(MediaType.TV, [1, 2]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 2, episodeNumber: null },
      'deleted',
      ctx.user.id
    );

    await send(ctx.request);

    const post = newSeries(calls);
    assert.ok(post);
    assert.strictEqual(post.addOptions.searchForMissingEpisodes, true);
    assert.deepStrictEqual(
      post.seasons.map((s) => [s.seasonNumber, s.monitored]),
      [
        [1, true],
        [2, false],
      ]
    );
    assert.deepStrictEqual(commands(calls), []);
    assert.ok(!calls.some((c) => c.url === '/episode'));
  });

  it('sendToSonarr waits for a new series to list episodes before holding them', async () => {
    const calls = installServarr({
      inLibrary: false,
      emptyEpisodeCalls: 2,
      episodes: [episode(1, 1), episode(1, 2), episode(1, 3)],
    });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 1, episodeNumber: 3 },
      'paused',
      ctx.user.id
    );

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await send(ctx.request);
      assert.strictEqual(
        newSeries(calls)?.addOptions.searchForMissingEpisodes,
        false
      );
      assert.deepStrictEqual(monitorCalls(calls), []);
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(EPISODE_POLL_MS);
        await settle();
      }
    } finally {
      mock.timers.reset();
    }

    assert.strictEqual(calls.filter((c) => c.url === '/episode').length, 3);
    assert.deepStrictEqual(monitorCalls(calls), [
      { episodeIds: [103], monitored: false },
    ]);
    assert.deepStrictEqual(commands(calls), [
      { name: 'EpisodeSearch', episodeIds: [101, 102] },
    ]);
  });

  it('sendToSonarr warns with the held episodes when a new series never lists episodes', async () => {
    const warn = mock.method(logger, 'warn');
    const calls = installServarr({
      inLibrary: false,
      emptyEpisodeCalls: 1000,
      episodes: [episode(1, 1)],
    });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 1, episodeNumber: 3 },
      'paused',
      ctx.user.id
    );

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await send(ctx.request);
      for (let i = 0; i < EPISODE_WAIT_MS / EPISODE_POLL_MS + 2; i++) {
        mock.timers.tick(EPISODE_POLL_MS);
        await settle();
      }
    } finally {
      mock.timers.reset();
    }

    assert.strictEqual(
      calls.filter((c) => c.url === '/episode').length,
      EPISODE_WAIT_MS / EPISODE_POLL_MS + 1
    );
    assert.deepStrictEqual(monitorCalls(calls), []);
    assert.deepStrictEqual(commands(calls), []);
    const held = warn.mock.calls
      .map((c) => (c.arguments as unknown[])[1] as { heldEpisodes?: string[] })
      .find((meta) => meta?.heldEpisodes);
    assert.deepStrictEqual(held?.heldEpisodes, ['S1E3']);
  });

  it('sendToSonarr retries a failed unmonitor once', async () => {
    const calls = installServarr({
      failMonitorCalls: 1,
      episodes: [
        episode(1, 1, { monitored: true }),
        episode(1, 2, { monitored: true }),
      ],
    });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 1, episodeNumber: 2 },
      'deleted',
      ctx.user.id
    );

    await send(ctx.request);

    assert.deepStrictEqual(
      monitorCalls(calls).filter((c) => !c.monitored),
      [
        { episodeIds: [102], monitored: false },
        { episodeIds: [102], monitored: false },
      ]
    );
  });

  it('sendToSonarr warns with the episode ids when the unmonitor fails twice', async () => {
    const warn = mock.method(logger, 'warn');
    const calls = installServarr({
      failMonitorCalls: 2,
      episodes: [
        episode(1, 1, { monitored: true }),
        episode(1, 2, { monitored: true }),
      ],
    });
    const ctx = await seed(MediaType.TV, [1]);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: 1, episodeNumber: 2 },
      'deleted',
      ctx.user.id
    );

    await send(ctx.request);

    const failed = warn.mock.calls
      .map((c) => (c.arguments as unknown[])[1] as { episodeIds?: number[] })
      .find((meta) => meta?.episodeIds);
    assert.deepStrictEqual(failed?.episodeIds, [102]);
    assert.deepStrictEqual(commands(calls), [
      { name: 'EpisodeSearch', episodeIds: [101] },
    ]);
  });

  it('request without controls is sent exactly as upstream', async () => {
    const calls = installServarr({
      episodes: [episode(1, 1), episode(2, 1)],
    });
    const ctx = await seed(MediaType.TV, [1, 2]);

    await send(ctx.request);

    assert.deepStrictEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'get /series/lookup',
        'put /series',
        'get /episode',
        'put /episode/monitor',
        'post /command',
      ]
    );
    assert.deepStrictEqual(
      seriesPut(calls)?.seasons.map((s) => [s.seasonNumber, s.monitored]),
      [
        [1, true],
        [2, true],
      ]
    );
    assert.deepStrictEqual(monitorCalls(calls), [
      { episodeIds: [101, 201], monitored: true },
    ]);
    assert.deepStrictEqual(commands(calls), [
      { name: 'MissingEpisodeSearch', seriesId: 7 },
    ]);
  });

  it('sendToRadarr skips a paused movie', async () => {
    const calls = installServarr({});
    const ctx = await seed(MediaType.MOVIE);
    await setControl(
      { requestId: ctx.request.id, seasonNumber: null, episodeNumber: null },
      'paused',
      ctx.user.id
    );

    await send(ctx.request);

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(tmdbCalls, []);
  });

  it('sendToRadarr sends a movie without controls', async () => {
    const calls = installServarr({});
    const ctx = await seed(MediaType.MOVIE);

    await send(ctx.request);

    assert.ok(calls.some((c) => c.method === 'post' && c.url === '/movie'));
  });
});
