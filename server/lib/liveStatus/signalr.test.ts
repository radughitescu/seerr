import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  HubConnectionBuilder,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  reconnectPolicy,
  servarrEventTarget,
  signalrLogger,
  startServarrSignalR,
  type ServarrMessage,
} from './signalr';

const server = (id: number, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: `server-${id}`,
    hostname: `host-${id}`,
    port: 8989,
    apiKey: `key ${id}`,
    useSsl: false,
    is4k: false,
    isDefault: true,
    ...over,
  }) as unknown as SonarrSettings & RadarrSettings;

describe('servarrEventTarget', () => {
  it('maps resources to series and movie ids', () => {
    assert.deepEqual(
      servarrEventTarget({
        name: 'episode',
        body: { resource: { seriesId: 4 } },
      }),
      [4]
    );
    assert.deepEqual(
      servarrEventTarget({
        name: 'episodefile',
        body: { resource: { seriesId: 5 } },
      }),
      [5]
    );
    assert.deepEqual(
      servarrEventTarget({ name: 'movie', body: { resource: { id: 6 } } }),
      [6]
    );
    assert.deepEqual(
      servarrEventTarget({
        name: 'moviefile',
        body: { resource: { movieId: 7 } },
      }),
      [7]
    );
    assert.deepEqual(
      servarrEventTarget({
        name: 'command',
        body: {
          resource: { name: 'MoviesSearch', body: { movieIds: [8, 9] } },
        },
      }),
      [8, 9]
    );
  });

  it('targets everything when the event has no id', () => {
    assert.equal(
      servarrEventTarget({ name: 'queue', body: { action: 'sync' } }),
      'all'
    );
    assert.equal(
      servarrEventTarget({
        name: 'command',
        body: {
          resource: { name: 'EpisodeSearch', body: { episodeIds: [1] } },
        },
      }),
      'all'
    );
  });

  it('reacts only to search, scan, refresh and download processing commands', () => {
    const command = (name: string, body: Record<string, unknown> = {}) =>
      servarrEventTarget({
        name: 'command',
        body: { resource: { name, body } },
      });
    for (const name of [
      'RssSync',
      'RefreshMonitoredDownloads',
      'Housekeeping',
      'MessagingCleanup',
      'CheckHealth',
    ]) {
      assert.equal(command(name), null, name);
    }
    assert.deepEqual(command('SeriesSearch', { seriesId: 4 }), [4]);
    assert.deepEqual(command('RescanMovie', { movieIds: [6] }), [6]);
    assert.equal(command('ProcessMonitoredDownloads'), 'all');
    assert.equal(command('MissingEpisodeSearch'), 'all');
    assert.equal(
      servarrEventTarget({
        name: 'command',
        body: { resource: { body: { name: 'DownloadedEpisodesScan' } } },
      }),
      'all'
    );
  });

  it('ignores other events', () => {
    assert.equal(servarrEventTarget({ name: 'health', body: {} }), null);
    assert.equal(servarrEventTarget({ name: 'queue/status', body: {} }), null);
  });

  it('logs signalr errors as warnings with the token redacted', () => {
    const warn = mock.method(logger, 'warn', () => logger);
    const debug = mock.method(logger, 'debug', () => logger);
    try {
      signalrLogger.log(
        LogLevel.Error,
        'Failed http://h/signalr/messages?access_token=secret&x=1'
      );
      signalrLogger.log(LogLevel.Critical, 'critical');
      signalrLogger.log(LogLevel.Warning, 'warning');
      signalrLogger.log(LogLevel.Information, 'info');

      assert.equal(warn.mock.callCount(), 2);
      assert.equal(
        warn.mock.calls[0].arguments[0],
        'Failed http://h/signalr/messages?access_token=[redacted]&x=1'
      );
      assert.equal(debug.mock.callCount(), 1);
      assert.equal(debug.mock.calls[0].arguments[0], 'warning');
    } finally {
      mock.restoreAll();
    }
  });

  it('keeps reconnecting after the default steps', () => {
    const delay = (previousRetryCount: number) =>
      reconnectPolicy.nextRetryDelayInMilliseconds({
        previousRetryCount,
        elapsedMilliseconds: 0,
        retryReason: new Error('x'),
      });
    assert.equal(delay(0), 0);
    assert.equal(delay(3), 30000);
    assert.equal(delay(50), 60000);
  });
});

describe('startServarrSignalR', () => {
  let saved: { sonarr: SonarrSettings[]; radarr: RadarrSettings[] };
  let handlers: ((msg: ServarrMessage) => void)[];
  let fakes: {
    start: ReturnType<typeof mock.fn>;
    stop: ReturnType<typeof mock.fn>;
  }[];
  let urls: string[];

  beforeEach(() => {
    const settings = getSettings();
    saved = { sonarr: settings.sonarr, radarr: settings.radarr };
    settings.sonarr = [server(0, { baseUrl: '/sonarr' })];
    settings.radarr = [server(3, { port: 7878 })];
    handlers = [];
    fakes = [];
    urls = [];
    const withUrl = HubConnectionBuilder.prototype.withUrl as (
      url: string
    ) => HubConnectionBuilder;
    mock.method(
      HubConnectionBuilder.prototype,
      'withUrl',
      function (this: HubConnectionBuilder, url: string) {
        urls.push(url);
        return withUrl.call(this, url);
      }
    );
    mock.method(HubConnectionBuilder.prototype, 'build', () => {
      const fake = {
        start: mock.fn(async () => undefined),
        stop: mock.fn(async () => undefined),
      };
      fakes.push(fake);
      return {
        ...fake,
        on: (name: string, cb: (msg: ServarrMessage) => void) => {
          if (name === 'receiveMessage') handlers.push(cb);
        },
        onclose: () => undefined,
      } as unknown as HubConnection;
    });
  });

  afterEach(() => {
    const settings = getSettings();
    settings.sonarr = saved.sonarr;
    settings.radarr = saved.radarr;
    mock.restoreAll();
  });

  it('opens one hub per configured server and forwards relevant events', () => {
    const events: [string, number, string][] = [];
    const stop = startServarrSignalR((kind, serverId, msg) =>
      events.push([kind, serverId, msg.name])
    );

    assert.deepEqual(urls, [
      'http://host-0:8989/sonarr/signalr/messages?access_token=key%200',
      'http://host-3:7878/signalr/messages?access_token=key%203',
    ]);
    assert.equal(fakes.length, 2);
    assert.ok(fakes.every((f) => f.start.mock.callCount() === 1));

    handlers[0]({ name: 'queue', body: {} });
    handlers[1]({ name: 'movie', body: { resource: { id: 1 } } });
    handlers[1]({ name: 'health', body: {} });
    assert.deepEqual(events, [
      ['sonarr', 0, 'queue'],
      ['radarr', 3, 'movie'],
    ]);

    stop();
    assert.ok(fakes.every((f) => f.stop.mock.callCount() === 1));
  });
});
