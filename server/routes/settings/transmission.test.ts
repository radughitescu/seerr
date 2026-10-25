import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

import TransmissionAPI from '@server/api/transmission';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import transmissionRoutes from './transmission';

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({ secret: 'test-secret', resave: false, saveUninitialized: false })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use(
    '/settings/transmission',
    isAuthenticated(Permission.ADMIN),
    transmissionRoutes
  );
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const prior = settings.main.localLogin;
  settings.main.localLogin = true;
  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = prior;
  }
}

describe('settings/transmission', () => {
  afterEach(() => mock.restoreAll());

  it('GET hides password and reports hasPassword', async () => {
    const settings = getSettings();
    settings.transmission = {
      ...settings.transmission,
      username: 'u',
      password: 'secret-pw',
    };
    const agent = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.get('/settings/transmission');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.password, '');
    assert.strictEqual(res.body.hasPassword, true);
    assert.ok(!JSON.stringify(res.body).includes('secret-pw'));
  });

  it('POST keeps existing password when body password is empty', async () => {
    const settings = getSettings();
    settings.transmission = {
      ...settings.transmission,
      password: 'secret-pw',
    };
    mock.method(settings, 'save', async () => undefined);
    const agent = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.post('/settings/transmission').send({
      enabled: true,
      hostname: 'tx',
      port: 9091,
      useSsl: false,
      rpcPath: '/transmission/rpc',
      username: 'u',
      password: '',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(getSettings().transmission.password, 'secret-pw');
    assert.strictEqual(getSettings().transmission.hostname, 'tx');
    assert.strictEqual(res.body.password, '');
    assert.strictEqual(res.body.hasPassword, true);
  });

  it('POST /test uses stored password when body password is empty', async () => {
    const settings = getSettings();
    settings.transmission = {
      ...settings.transmission,
      password: 'secret-pw',
    };
    mock.method(TransmissionAPI.prototype, 'test', async () => ({
      version: '4.0.5',
    }));
    const agent = await loginAs('admin@seerr.dev', 'test1234');

    const res = await agent.post('/settings/transmission/test').send({
      enabled: true,
      hostname: 'tx',
      port: 9091,
      useSsl: false,
      rpcPath: '/transmission/rpc',
      username: 'u',
      password: '',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.version, '4.0.5');
  });

  it('non-admin gets 403', async () => {
    const agent = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent.get('/settings/transmission');

    assert.strictEqual(res.status, 403);
  });
});
