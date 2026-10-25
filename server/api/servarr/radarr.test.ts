import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('RadarrAPI request controls', () => {
  afterEach(() => mock.restoreAll());

  it('setMovieMonitored PUTs the full movie with monitored flipped', async () => {
    const radarr = buildRadarr();
    const movie = { id: 7, title: 'T', monitored: true };
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: movie,
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.setMovieMonitored(7, false);

    assert.strictEqual(get.mock.calls[0].arguments[0], '/movie/7');
    assert.deepStrictEqual(put.mock.calls[0].arguments, [
      '/movie/7',
      { id: 7, title: 'T', monitored: false },
    ]);
  });

  it('getMovieFiles GETs /moviefile for the movie', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 3 }],
    }));

    const result = await radarr.getMovieFiles(7);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/moviefile',
      { params: { movieId: 7 } },
    ]);
    assert.deepStrictEqual(result, [{ id: 3 }]);
  });

  it('deleteMovieFile DELETEs /moviefile/{id}', async () => {
    const radarr = buildRadarr();
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.deleteMovieFile(3);

    assert.strictEqual(del.mock.calls[0].arguments[0], '/moviefile/3');
  });

  it('getQueueFor requests the movie queue', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: { records: [] },
    }));

    await radarr.getQueueFor({ movieId: 7 });

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/queue',
      {
        params: { movieIds: [7], includeEpisode: true, pageSize: 1000 },
        paramsSerializer: { indexes: null },
      },
    ]);
  });

  it('searchMovieStrict POSTs a MoviesSearch command', async () => {
    const radarr = buildRadarr();
    const post = mock.method(getAxios(radarr), 'post', async () => ({}));

    await radarr.searchMovieStrict(7);

    assert.deepStrictEqual(post.mock.calls[0].arguments, [
      '/command',
      { name: 'MoviesSearch', movieIds: [7] },
    ]);
  });

  it('searchMovieStrict rejects when the command fails', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'post', async () => {
      throw new Error('timeout');
    });

    await assert.rejects(() => radarr.searchMovieStrict(7), /timeout/);
  });

  it('getMovieHistory GETs /history/movie for the item', async () => {
    const api = buildRadarr();
    const records = [{ id: 1, downloadId: 'abc', eventType: 'grabbed' }];
    const get = mock.method(getAxios(api), 'get', async () => ({
      data: records,
    }));

    const result = await api.getMovieHistory(7);

    assert.deepStrictEqual(get.mock.calls[0].arguments, [
      '/history/movie',
      { params: { movieId: 7 } },
    ]);
    assert.deepStrictEqual(result, records);
  });
});
