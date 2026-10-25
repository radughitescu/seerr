import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

describe('SonarrAPI removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tvdbId is unknown to the lookup', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(() => sonarr.removeSeries(1234), /Series not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when the lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});

describe('SonarrAPI request controls', () => {
  afterEach(() => mock.restoreAll());

  it('setEpisodesMonitored(false) PUTs /episode/monitor with monitored false', async () => {
    const sonarr = buildSonarr();
    const put = mock.method(getAxios(sonarr), 'put', async () => ({}));

    await sonarr.setEpisodesMonitored([1, 2], false);

    assert.deepStrictEqual(put.mock.calls[0].arguments, [
      '/episode/monitor',
      { episodeIds: [1, 2], monitored: false },
    ]);
  });

  it('monitorEpisodes PUTs monitored true', async () => {
    const sonarr = buildSonarr();
    const put = mock.method(getAxios(sonarr), 'put', async () => ({}));

    await sonarr.monitorEpisodes([3]);

    assert.deepStrictEqual(put.mock.calls[0].arguments, [
      '/episode/monitor',
      { episodeIds: [3], monitored: true },
    ]);
  });

  it('setSeasonMonitored flips only the given season', async () => {
    const sonarr = buildSonarr();
    const series = {
      id: 5,
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
      ],
    };
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: series,
    }));
    const put = mock.method(getAxios(sonarr), 'put', async () => ({}));

    await sonarr.setSeasonMonitored(5, 2, false);

    assert.strictEqual(get.mock.calls[0].arguments[0], '/series/5');
    assert.strictEqual(put.mock.calls[0].arguments[0], '/series/5');
    assert.deepStrictEqual(put.mock.calls[0].arguments[1], {
      id: 5,
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
      ],
    });
  });

  it('searchEpisodes POSTs an EpisodeSearch command', async () => {
    const sonarr = buildSonarr();
    const post = mock.method(getAxios(sonarr), 'post', async () => ({}));

    await sonarr.searchEpisodes([7, 8]);

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'EpisodeSearch', episodeIds: [7, 8] },
    ]);
  });

  it('searchSeason POSTs a SeasonSearch command', async () => {
    const sonarr = buildSonarr();
    const post = mock.method(getAxios(sonarr), 'post', async () => ({}));

    await sonarr.searchSeason(5, 2);

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'SeasonSearch', seriesId: 5, seasonNumber: 2 },
    ]);
  });

  it('getEpisodeFiles GETs /episodefile for the series', async () => {
    const sonarr = buildSonarr();
    const files = [{ id: 1 }];
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: files,
    }));

    const result = await sonarr.getEpisodeFiles(5);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/episodefile',
      { params: { seriesId: 5 } },
    ]);
    assert.deepStrictEqual(result, files);
  });

  it('deleteEpisodeFiles DELETEs /episodefile/bulk with ids', async () => {
    const sonarr = buildSonarr();
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.deleteEpisodeFiles([4, 5]);

    assert.deepStrictEqual(del.mock.calls[0].arguments, [
      '/episodefile/bulk',
      { data: { episodeFileIds: [4, 5] } },
    ]);
  });

  it('getQueueFor requests the series queue with episodes', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: { records: [{ id: 1 }] },
    }));

    const result = await sonarr.getQueueFor({ seriesId: 5 });

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/queue',
      {
        params: {
          seriesIds: [5],
          includeEpisode: true,
          pageSize: 1000,
        },
        paramsSerializer: { indexes: null },
      },
    ]);
    assert.deepStrictEqual(result, [{ id: 1 }]);
  });

  it('removeQueueItems DELETEs /queue/bulk with removeFromClient, blocklist=false, skipRedownload=true', async () => {
    const sonarr = buildSonarr();
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeQueueItems([1, 2], true);

    assert.deepStrictEqual(del.mock.calls[0].arguments, [
      '/queue/bulk',
      {
        data: { ids: [1, 2] },
        params: {
          removeFromClient: true,
          blocklist: false,
          skipRedownload: true,
        },
      },
    ]);
  });

  it('getCommands GETs /command', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 1 }],
    }));

    const result = await sonarr.getCommands();

    assert.strictEqual(get.mock.calls[0].arguments[0], '/command');
    assert.deepStrictEqual(result, [{ id: 1 }]);
  });
});
