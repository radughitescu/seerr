import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type RadarrAPI from '@server/api/servarr/radarr';
import type SonarrAPI from '@server/api/servarr/sonarr';
import type TransmissionAPI from '@server/api/transmission';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type {
  RadarrSettings,
  SonarrSettings,
  TransmissionSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { clients, loadRequestInputs } from './sources';

const HASH = 'A'.repeat(40);

const server = (id: number, over: Partial<SonarrSettings> = {}) =>
  ({
    id,
    name: `server-${id}`,
    hostname: `host-${id}`,
    port: 8989,
    apiKey: `key-${id}`,
    useSsl: false,
    is4k: false,
    isDefault: id === 0,
    ...over,
  }) as SonarrSettings & RadarrSettings;

const tvRequest = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    type: 'tv',
    is4k: false,
    serverId: null,
    media: { externalServiceId: 42, externalServiceId4k: 77 },
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    ...over,
  }) as unknown as MediaRequest;

const movieRequest = (over: Record<string, unknown> = {}) =>
  ({
    id: 2,
    type: 'movie',
    is4k: false,
    serverId: null,
    media: { externalServiceId: 9 },
    seasons: [],
    ...over,
  }) as unknown as MediaRequest;

const fakeSonarr = (over: Record<string, unknown> = {}) => ({
  getEpisodes: mock.fn<(seriesId: number) => Promise<unknown[]>>(async () => [
    {
      id: 101,
      seriesId: 42,
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Pilot',
      monitored: true,
      hasFile: true,
      episodeFileId: 500,
      lastSearchTime: '2026-10-01T00:00:00Z',
    },
    {
      id: 102,
      seriesId: 42,
      seasonNumber: 1,
      episodeNumber: 2,
      title: 'Second',
      monitored: true,
      hasFile: false,
      episodeFileId: 0,
    },
    {
      id: 301,
      seriesId: 42,
      seasonNumber: 3,
      episodeNumber: 1,
      title: 'Not requested',
      monitored: false,
      hasFile: false,
      episodeFileId: 0,
    },
  ]),
  getEpisodeFiles: mock.fn(async () => [
    { id: 500, seriesId: 42, seasonNumber: 1, size: 1234 },
  ]),
  getQueueFor: mock.fn<(params: { seriesId?: number }) => Promise<unknown[]>>(
    async () => [
      {
        id: 1,
        downloadId: HASH,
        episodeId: 102,
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
        statusMessages: [],
        size: 10,
        sizeleft: 5,
      },
      {
        id: 2,
        downloadId: 'SABnzbd_nzo_abc',
        episodeId: 102,
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
        statusMessages: [],
        size: 10,
        sizeleft: 5,
      },
    ]
  ),
  getCommands: mock.fn(async () => [
    {
      id: 1,
      name: 'EpisodeSearch',
      status: 'started',
      body: { episodeIds: [102] },
    },
    {
      id: 2,
      name: 'SeasonSearch',
      status: 'queued',
      body: { seriesId: 42, seasonNumber: 2 },
    },
    {
      id: 3,
      name: 'SeriesSearch',
      status: 'completed',
      body: { seriesId: 42 },
    },
    { id: 4, name: 'RefreshSeries', status: 'started', body: { seriesId: 42 } },
  ]),
  ...over,
});

const fakeRadarr = (over: Record<string, unknown> = {}) => ({
  getMovie: mock.fn(async () => ({
    id: 9,
    monitored: true,
    hasFile: true,
    lastSearchTime: '2026-10-02T00:00:00Z',
  })),
  getMovieFiles: mock.fn(async () => [{ id: 1, movieId: 9, size: 900 }]),
  getQueueFor: mock.fn(async () => []),
  getCommands: mock.fn(async () => [
    { id: 1, name: 'MoviesSearch', status: 'started', body: { movieIds: [9] } },
  ]),
  ...over,
});

const torrent = {
  hashString: HASH.toLowerCase(),
  name: 'Show.S01',
  status: 4,
  percentDone: 0.5,
  rateDownload: 1,
  eta: 10,
  peersSendingToUs: 1,
  peersConnected: 1,
  sizeWhenDone: 10,
  error: 0,
  errorString: '',
  files: [],
  fileStats: [],
};

describe('loadRequestInputs', () => {
  setupTestDb();

  let saved: {
    sonarr: SonarrSettings[];
    radarr: RadarrSettings[];
    transmission: TransmissionSettings;
  };
  let getTorrents: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    const settings = getSettings();
    saved = {
      sonarr: settings.sonarr,
      radarr: settings.radarr,
      transmission: settings.transmission,
    };
    settings.sonarr = [server(0), server(1)];
    settings.radarr = [server(0)];
    settings.transmission = {
      ...settings.transmission,
      enabled: true,
      hostname: 'transmission',
    };
    getTorrents = mock.fn(async () => [torrent]);
    mock.method(
      clients,
      'transmission',
      () => ({ getTorrents }) as unknown as TransmissionAPI
    );
  });

  afterEach(() => {
    const settings = getSettings();
    settings.sonarr = saved.sonarr;
    settings.radarr = saved.radarr;
    settings.transmission = saved.transmission;
    mock.restoreAll();
  });

  it('builds tv inputs with episode ids, series id, sizes and running searches', async () => {
    const sonarr = fakeSonarr();
    const build = mock.method(
      clients,
      'sonarr',
      (() => sonarr) as unknown as typeof clients.sonarr
    );

    const result = await loadRequestInputs(tvRequest());

    assert.equal(build.mock.calls[0].arguments[0].id, 0);
    assert.equal(sonarr.getEpisodes.mock.calls[0].arguments[0], 42);
    assert.equal(result.requestId, 1);
    assert.equal(result.type, 'tv');
    assert.equal(result.seriesId, 42);
    assert.deepEqual(result.requestedSeasons, [1, 2]);
    assert.deepEqual(result.controls, []);
    assert.deepEqual(result.failedSources, []);
    assert.ok(!Number.isNaN(Date.parse(result.now)));
    assert.deepEqual(result.episodes, [
      {
        id: 101,
        seasonNumber: 1,
        episodeNumber: 1,
        title: 'Pilot',
        monitored: true,
        hasFile: true,
        episodeFileId: 500,
        sizeOnDisk: 1234,
        lastSearchTime: '2026-10-01T00:00:00Z',
      },
      {
        id: 102,
        seasonNumber: 1,
        episodeNumber: 2,
        title: 'Second',
        monitored: true,
        hasFile: false,
      },
    ]);
    assert.equal(result.queue.length, 2);
    assert.deepEqual(result.runningSearches, [
      { episodeIds: [102] },
      { seriesId: 42, seasonNumber: 2 },
    ]);
    assert.deepEqual(getTorrents.mock.calls[0].arguments[0], [HASH]);
    assert.equal(result.torrents.length, 1);
  });

  it('uses the request server override and the 4k service id', async () => {
    const sonarr = fakeSonarr();
    const build = mock.method(
      clients,
      'sonarr',
      (() => sonarr) as unknown as typeof clients.sonarr
    );

    const result = await loadRequestInputs(
      tvRequest({ serverId: 1, is4k: true })
    );

    assert.equal(build.mock.calls[0].arguments[0].id, 1);
    assert.equal(sonarr.getEpisodes.mock.calls[0].arguments[0], 77);
    assert.deepEqual(sonarr.getQueueFor.mock.calls[0].arguments[0], {
      seriesId: 77,
    });
    assert.equal(result.seriesId, 77);
  });

  it('builds movie inputs from radarr', async () => {
    const radarr = fakeRadarr();
    mock.method(clients, 'radarr', () => radarr as unknown as RadarrAPI);

    const result = await loadRequestInputs(movieRequest());

    assert.equal(result.type, 'movie');
    assert.equal(result.movieId, 9);
    assert.deepEqual(result.movie, {
      monitored: true,
      hasFile: true,
      sizeOnDisk: 900,
      lastSearchTime: '2026-10-02T00:00:00Z',
    });
    assert.deepEqual(result.runningSearches, [{ movieIds: [9] }]);
    assert.equal(getTorrents.mock.callCount(), 0);
    assert.deepEqual(result.torrents, []);
    assert.deepEqual(result.failedSources, []);
  });

  it('makes no external calls when the media has no external service id', async () => {
    const build = mock.method(
      clients,
      'sonarr',
      () => fakeSonarr() as unknown as SonarrAPI
    );

    const result = await loadRequestInputs(
      tvRequest({ media: { externalServiceId: null } })
    );

    assert.equal(build.mock.callCount(), 0);
    assert.equal(getTorrents.mock.callCount(), 0);
    assert.deepEqual(result.episodes, []);
    assert.deepEqual(result.failedSources, []);
    assert.deepEqual(result.requestedSeasons, [1, 2]);
  });

  it('sources: transmission disabled yields no torrents and no failure', async () => {
    getSettings().transmission = {
      ...getSettings().transmission,
      enabled: false,
    };
    mock.method(clients, 'sonarr', () => fakeSonarr() as unknown as SonarrAPI);

    const result = await loadRequestInputs(tvRequest());

    assert.equal(getTorrents.mock.callCount(), 0);
    assert.deepEqual(result.torrents, []);
    assert.deepEqual(result.failedSources, []);
    assert.equal(result.queue.length, 2);
  });

  it('sources: sonarr failure lands in failedSources and radarr/transmission still load', async () => {
    mock.method(
      clients,
      'sonarr',
      () =>
        fakeSonarr({
          getEpisodes: mock.fn(async () => {
            throw new Error('Sonarr unreachable');
          }),
        }) as unknown as SonarrAPI
    );
    mock.method(clients, 'radarr', () => fakeRadarr() as unknown as RadarrAPI);

    const tv = await loadRequestInputs(tvRequest());
    assert.deepEqual(tv.failedSources, ['sonarr']);
    assert.deepEqual(tv.episodes, []);
    assert.equal(tv.queue.length, 2);
    assert.equal(tv.torrents.length, 1);

    const movie = await loadRequestInputs(movieRequest());
    assert.deepEqual(movie.failedSources, []);
    assert.equal(movie.movie?.hasFile, true);
  });

  it('transmission failure lands in failedSources', async () => {
    getTorrents = mock.fn(async () => {
      throw new Error('Transmission unreachable');
    });
    mock.method(clients, 'sonarr', () => fakeSonarr() as unknown as SonarrAPI);

    const result = await loadRequestInputs(tvRequest());

    assert.deepEqual(result.failedSources, ['transmission']);
    assert.deepEqual(result.torrents, []);
    assert.equal(result.episodes.length, 2);
  });

  it('missing servarr server marks the source failed', async () => {
    getSettings().sonarr = [];
    const build = mock.method(
      clients,
      'sonarr',
      () => fakeSonarr() as unknown as SonarrAPI
    );

    const result = await loadRequestInputs(tvRequest());

    assert.equal(build.mock.callCount(), 0);
    assert.deepEqual(result.failedSources, ['sonarr']);
  });
});
