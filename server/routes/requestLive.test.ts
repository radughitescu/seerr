import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { RequestInputs } from '@server/lib/liveStatus/derive';
import { liveStatusHub } from '@server/lib/liveStatus/hub';
import { sources } from '@server/lib/liveStatus/sources';
import type { RequestLiveState } from '@server/lib/liveStatus/types';
import { Permission } from '@server/lib/permissions';
import {
  ServiceError,
  actions,
  type ActionRequest,
} from '@server/lib/requestControls/actions';
import { previews } from '@server/lib/requestControls/preview';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import requestRoutes from './request';

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

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        return next(err);
      }
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(() => {
  app = createApp();
});

after(() => {
  liveStatusHub.shutdown();
});

setupTestDb();

async function loginAs(email: string) {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent
      .post('/auth/local')
      .send({ email, password: 'test1234' });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
}

let tmdbId = 1000;

async function seedRequest(ownerEmail: string) {
  const owner = await getRepository(User).findOneOrFail({
    where: { email: ownerEmail },
  });
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: tmdbId++,
      status: MediaStatus.PROCESSING,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: owner,
      is4k: false,
    })
  );
}

async function grant(email: string, permissions: number) {
  const repo = getRepository(User);
  const user = await repo.findOneOrFail({ where: { email } });
  user.permissions = permissions;
  await repo.save(user);
}

const liveState = (requestId: number): RequestLiveState => ({
  requestId,
  available: true,
  summary: { status: 'paused', ready: 0, total: 1, paused: 1, deleted: 0 },
  seasons: [],
  movie: {
    seasonNumber: null,
    episodeNumber: null,
    status: 'paused',
    actions: ['resume', 'delete'],
  },
  actions: ['resume', 'delete'],
  updatedAt: '2026-10-25T00:00:00.000Z',
});

const movieInputs = (requestId: number, hasFile: boolean): RequestInputs => ({
  requestId,
  type: 'movie',
  now: new Date().toISOString(),
  controls: [],
  episodes: [],
  movieId: 9,
  movie: { monitored: true, hasFile },
  queue: [],
  torrents: [],
  runningSearches: [],
  requestedSeasons: [],
  failedSources: [],
});

describe('POST /request/:requestId/control', () => {
  afterEach(() => {
    mock.restoreAll();
    stubSubscribers();
  });

  it('requester can POST control', async () => {
    const mediaRequest = await seedRequest('demo@seerr.dev');
    const run = mock.method(
      actions,
      'runAction',
      async (input: ActionRequest) => liveState(input.request.id)
    );
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'pause' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestId, mediaRequest.id);
    const args = run.mock.calls[0].arguments[0];
    assert.strictEqual(args.action, 'pause');
    assert.strictEqual(args.seasonNumber, null);
    assert.strictEqual(args.episodeNumber, null);
    assert.strictEqual(args.request.id, mediaRequest.id);
    assert.strictEqual(args.user.email, 'demo@seerr.dev');
  });

  it("REQUEST_VIEW user can POST control on another user's request", async () => {
    const mediaRequest = await seedRequest('admin@seerr.dev');
    await grant('demo@seerr.dev', Permission.REQUEST | Permission.REQUEST_VIEW);
    const run = mock.method(
      actions,
      'runAction',
      async (input: ActionRequest) => liveState(input.request.id)
    );
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'delete', seasonNumber: 1, episodeNumber: 2 });
    assert.strictEqual(res.status, 200);
    const args = run.mock.calls[0].arguments[0];
    assert.strictEqual(args.seasonNumber, 1);
    assert.strictEqual(args.episodeNumber, 2);
  });

  it("MANAGE_REQUESTS user can POST control on another user's request", async () => {
    const mediaRequest = await seedRequest('admin@seerr.dev');
    await grant(
      'demo@seerr.dev',
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );
    const run = mock.method(
      actions,
      'runAction',
      async (input: ActionRequest) => liveState(input.request.id)
    );
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'pause', seasonNumber: 1 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(run.mock.callCount(), 1);
  });

  it('user without view rights gets 403', async () => {
    const mediaRequest = await seedRequest('admin@seerr.dev');
    const run = mock.method(
      actions,
      'runAction',
      async (input: ActionRequest) => liveState(input.request.id)
    );
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'pause' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(run.mock.callCount(), 0);
    const preview = await agent.get(
      `/request/${mediaRequest.id}/control/delete-preview`
    );
    assert.strictEqual(preview.status, 403);
  });

  it('ServiceError maps to 502 with service name', async () => {
    const mediaRequest = await seedRequest('demo@seerr.dev');
    mock.method(actions, 'runAction', async () => {
      throw new ServiceError('transmission', 'connect ECONNREFUSED');
    });
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'pause' });
    assert.strictEqual(res.status, 502);
    assert.deepStrictEqual(res.body, {
      service: 'transmission',
      message: 'connect ECONNREFUSED',
    });
  });

  it('rejects an unknown action with 400', async () => {
    const mediaRequest = await seedRequest('demo@seerr.dev');
    const run = mock.method(
      actions,
      'runAction',
      async (input: ActionRequest) => liveState(input.request.id)
    );
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post(`/request/${mediaRequest.id}/control`)
      .send({ action: 'explode' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(run.mock.callCount(), 0);
  });

  it('returns 404 for a missing request', async () => {
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent
      .post('/request/99999/control')
      .send({ action: 'pause' });
    assert.strictEqual(res.status, 404);
  });
});

describe('GET /request/:requestId/control/delete-preview', () => {
  afterEach(() => {
    mock.restoreAll();
    stubSubscribers();
  });

  it('delete-preview returns 403 for a user without view rights', async () => {
    const mediaRequest = await seedRequest('admin@seerr.dev');
    const get = mock.method(previews, 'getDeletePreview', async () => ({
      files: [],
      bytesFreed: 0,
      torrentKept: false,
    }));
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent.get(
      `/request/${mediaRequest.id}/control/delete-preview?seasonNumber=1`
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(get.mock.callCount(), 0);
  });

  it('returns the preview for the requested item', async () => {
    const mediaRequest = await seedRequest('demo@seerr.dev');
    const preview = {
      files: [{ path: '/tv/a.mkv', bytes: 10, episodes: ['S01E02'] }],
      bytesFreed: 10,
      torrentKept: false,
    };
    const get = mock.method(previews, 'getDeletePreview', async () => preview);
    const agent = await loginAs('demo@seerr.dev');
    const res = await agent.get(
      `/request/${mediaRequest.id}/control/delete-preview?seasonNumber=1&episodeNumber=2`
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, preview);
    const args = get.mock.calls[0].arguments as unknown[];
    assert.strictEqual((args[0] as MediaRequest).id, mediaRequest.id);
    assert.strictEqual(args[1], 1);
    assert.strictEqual(args[2], 2);
  });
});

describe('GET /request/live', () => {
  afterEach(() => {
    mock.restoreAll();
    stubSubscribers();
  });

  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it('SSE sends snapshot then delta and unsubscribes on close', async () => {
    const own = await seedRequest('demo@seerr.dev');
    const other = await seedRequest('admin@seerr.dev');
    let hasFile = false;
    mock.method(sources, 'findRequest', async (id: number) =>
      getRepository(MediaRequest).findOne({ where: { id } })
    );
    const load = mock.method(
      sources,
      'loadRequestInputs',
      async (r: MediaRequest) => movieInputs(r.id, hasFile)
    );
    const agent = await loginAs('demo@seerr.dev');

    const events: { event: string; data: unknown }[] = [];
    let headers: IncomingMessage['headers'] = {};
    await new Promise<void>((resolve) => {
      agent
        .get(`/request/live?ids=${own.id},${other.id}`)
        .buffer(false)
        .parse((response, callback) => {
          const res = response as unknown as IncomingMessage;
          headers = res.headers;
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const event = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (!event || data === undefined) continue;
              events.push({ event, data: JSON.parse(data) });
              if (event === 'snapshot') {
                hasFile = true;
                void liveStatusHub.refresh(own.id);
              } else if (event === 'delta') {
                res.destroy();
                resolve();
              }
            }
          });
          res.on('close', () => callback(null, buffer));
        })
        .end(() => resolve());
    });

    assert.match(String(headers['content-type']), /^text\/event-stream/);
    assert.strictEqual(headers['cache-control'], 'no-cache');
    assert.strictEqual(headers['x-accel-buffering'], 'no');
    assert.deepStrictEqual(
      events.map((e) => e.event),
      ['snapshot', 'delta']
    );
    const snapshot = events[0].data as RequestLiveState;
    assert.strictEqual(snapshot.requestId, own.id);
    assert.strictEqual(snapshot.movie?.status, 'unknown');
    const deltas = events[1].data as { requestId: number }[];
    assert.ok(deltas.length > 0);
    assert.ok(deltas.every((d) => d.requestId === own.id));
    assert.ok(
      load.mock.calls.every((c) => c.arguments[0].id === own.id),
      'requests the user cannot view are not loaded'
    );

    await waitFor(() => liveStatusHub.clientCount() === 0);
    assert.strictEqual(liveStatusHub.clientCount(), 0);
  });

  it('ids over 50 returns 400', async () => {
    const agent = await loginAs('demo@seerr.dev');
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(',');
    const res = await agent.get(`/request/live?ids=${ids}`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(liveStatusHub.clientCount(), 0);
  });

  it('rejects ids that are not positive integers', async () => {
    const agent = await loginAs('demo@seerr.dev');
    for (const ids of ['', '1,abc', '0', '-3', '1.5']) {
      const res = await agent.get(`/request/live?ids=${ids}`);
      assert.strictEqual(res.status, 400, `ids=${ids}`);
    }
  });
});
