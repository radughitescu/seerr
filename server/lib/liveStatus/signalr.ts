import {
  HubConnectionBuilder,
  LogLevel,
  type HubConnection,
  type ILogger,
  type RetryContext,
} from '@microsoft/signalr';
import ServarrBase from '@server/api/servarr/base';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { ServiceKind } from './sources';

export type ServarrMessage = { name: string; body: unknown };

export type ServarrEventHandler = (
  kind: ServiceKind,
  serverId: number,
  msg: ServarrMessage
) => void;

export const SERVARR_EVENTS = [
  'queue',
  'command',
  'episode',
  'episodefile',
  'movie',
  'moviefile',
];

const START_RETRY_MS = 30000;
const MAX_RECONNECT_MS = 60000;
const RECONNECT_STEPS = [0, 2000, 10000, 30000];

type Resource = {
  id?: number;
  seriesId?: number;
  movieId?: number;
  body?: { seriesId?: number; movieIds?: number[] };
};

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export function servarrEventTarget(
  msg: ServarrMessage
): 'all' | number[] | null {
  if (!msg || !SERVARR_EVENTS.includes(msg.name)) {
    return null;
  }
  const resource = (msg.body as { resource?: Resource } | undefined)?.resource;
  let ids: unknown[] = [];
  switch (msg.name) {
    case 'episode':
    case 'episodefile':
      ids = [resource?.seriesId];
      break;
    case 'movie':
      ids = [resource?.id];
      break;
    case 'moviefile':
      ids = [resource?.movieId];
      break;
    case 'command':
      ids = [resource?.body?.seriesId, ...(resource?.body?.movieIds ?? [])];
      break;
  }
  const found = ids.filter(isNumber);
  return found.length ? found : 'all';
}

export const redactToken = (text: string): string =>
  text.replace(/access_token=[^&\s]+/g, 'access_token=[redacted]');

export const signalrLogger: ILogger = {
  log(level: LogLevel, message: string) {
    if (level >= LogLevel.Error) {
      logger.warn(redactToken(message), { label: 'LiveStatus' });
    } else if (level >= LogLevel.Warning) {
      logger.debug(redactToken(message), { label: 'LiveStatus' });
    }
  },
};

export const reconnectPolicy = {
  nextRetryDelayInMilliseconds(ctx: RetryContext): number {
    return RECONNECT_STEPS[ctx.previousRetryCount] ?? MAX_RECONNECT_MS;
  },
};

export function signalrUrl(server: DVRSettings): string {
  return `${ServarrBase.buildUrl(
    server,
    '/signalr/messages'
  )}?access_token=${encodeURIComponent(server.apiKey)}`;
}

export function startServarrSignalR(onEvent: ServarrEventHandler): () => void {
  const settings = getSettings();
  const servers: { kind: ServiceKind; server: DVRSettings }[] = [
    ...settings.sonarr.map((server) => ({ kind: 'sonarr' as const, server })),
    ...settings.radarr.map((server) => ({ kind: 'radarr' as const, server })),
  ];
  const connections: HubConnection[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  for (const { kind, server } of servers) {
    const connection = new HubConnectionBuilder()
      .withUrl(signalrUrl(server))
      .withAutomaticReconnect(reconnectPolicy)
      .configureLogging(signalrLogger)
      .build();

    connection.on('receiveMessage', (msg: ServarrMessage) => {
      if (msg && SERVARR_EVENTS.includes(msg.name)) {
        try {
          onEvent(kind, server.id, msg);
        } catch (e) {
          logger.error('Live status event handler failed', {
            label: 'LiveStatus',
            errorMessage: redactToken(
              e instanceof Error ? e.message : String(e)
            ),
          });
        }
      }
    });

    const start = () => {
      if (stopped) return;
      connection.start().then(
        () => {
          logger.debug(`Connected to ${kind} SignalR`, {
            label: 'LiveStatus',
            server: server.name,
          });
        },
        (e) => {
          if (stopped) return;
          logger.warn(`Failed to connect to ${kind} SignalR`, {
            label: 'LiveStatus',
            server: server.name,
            errorMessage: redactToken(
              e instanceof Error ? e.message : String(e)
            ),
          });
          const timer = setTimeout(() => {
            timers.delete(timer);
            start();
          }, START_RETRY_MS);
          timers.add(timer);
        }
      );
    };

    connection.onclose(() => {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        start();
      }, START_RETRY_MS);
      timers.add(timer);
    });

    connections.push(connection);
    start();
  }

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const connection of connections) {
      connection.stop().catch(() => undefined);
    }
  };
}
