import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import TransmissionAPI from '@server/api/transmission';

function build(): TransmissionAPI {
  return new TransmissionAPI({
    enabled: true,
    hostname: 'localhost',
    port: 9091,
    useSsl: false,
    rpcPath: '/transmission/rpc',
    username: 'u',
    password: 'p',
  });
}

function getAxios(api: TransmissionAPI): AxiosInstance {
  return (api as unknown as { axios: AxiosInstance }).axios;
}

describe('TransmissionAPI', () => {
  afterEach(() => mock.restoreAll());

  it('retries once with X-Transmission-Session-Id after a 409', async () => {
    const api = build();
    let calls = 0;
    const post = mock.method(getAxios(api), 'post', async () => {
      calls += 1;
      if (calls === 1) {
        throw {
          response: {
            status: 409,
            headers: { 'x-transmission-session-id': 'abc' },
          },
        };
      }
      return { data: { result: 'success', arguments: { version: '4.0.5' } } };
    });

    const res = await api.test();

    assert.strictEqual(res.version, '4.0.5');
    assert.strictEqual(post.mock.callCount(), 2);
    const config = post.mock.calls[1].arguments[2] as {
      headers: Record<string, string>;
    };
    assert.strictEqual(config.headers['X-Transmission-Session-Id'], 'abc');
  });

  it('getTorrents sends torrent-get with lowercase hashes and the TorrentInfo fields', async () => {
    const api = build();
    const post = mock.method(getAxios(api), 'post', async () => ({
      data: { result: 'success', arguments: { torrents: [{ name: 'x' }] } },
    }));

    const torrents = await api.getTorrents(['ABCDEF', 'AbC123']);

    assert.strictEqual(torrents.length, 1);
    const body = post.mock.calls[0].arguments[1] as {
      method: string;
      arguments: { ids: string[]; fields: string[] };
    };
    assert.strictEqual(body.method, 'torrent-get');
    assert.deepStrictEqual(body.arguments.ids, ['abcdef', 'abc123']);
    assert.ok(body.arguments.fields.includes('files'));
    assert.ok(body.arguments.fields.includes('fileStats'));
  });

  it('setFilesWanted(false) sends torrent-set files-unwanted', async () => {
    const api = build();
    const post = mock.method(getAxios(api), 'post', async () => ({
      data: { result: 'success', arguments: {} },
    }));

    await api.setFilesWanted('ABC', [1, 2], false);

    const body = post.mock.calls[0].arguments[1] as {
      method: string;
      arguments: Record<string, unknown>;
    };
    assert.strictEqual(body.method, 'torrent-set');
    assert.deepStrictEqual(body.arguments['files-unwanted'], [1, 2]);
    assert.deepStrictEqual(body.arguments.ids, ['abc']);
    assert.strictEqual(body.arguments['files-wanted'], undefined);
  });

  it('remove(hashes, true) sends torrent-remove with delete-local-data true', async () => {
    const api = build();
    const post = mock.method(getAxios(api), 'post', async () => ({
      data: { result: 'success', arguments: {} },
    }));

    await api.remove(['ABC'], true);

    const body = post.mock.calls[0].arguments[1] as {
      method: string;
      arguments: Record<string, unknown>;
    };
    assert.strictEqual(body.method, 'torrent-remove');
    assert.strictEqual(body.arguments['delete-local-data'], true);
    assert.deepStrictEqual(body.arguments.ids, ['abc']);
  });
});
