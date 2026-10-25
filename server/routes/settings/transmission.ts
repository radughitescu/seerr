import TransmissionAPI from '@server/api/transmission';
import type { TransmissionSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const transmissionRoutes = Router();

const publicView = (s: TransmissionSettings) => ({
  ...s,
  password: '',
  hasPassword: s.password !== '',
});

const resolve = (body: TransmissionSettings): TransmissionSettings => {
  const current = getSettings().transmission;
  return {
    enabled: Boolean(body.enabled),
    hostname: body.hostname,
    port: Number(body.port),
    useSsl: Boolean(body.useSsl),
    rpcPath: body.rpcPath,
    username: body.username ?? '',
    password: body.password ? body.password : current.password,
  };
};

transmissionRoutes.get('/', (_req, res) => {
  res.status(200).json(publicView(getSettings().transmission));
});

transmissionRoutes.post('/', async (req, res) => {
  const settings = getSettings();
  settings.transmission = resolve(req.body as TransmissionSettings);
  await settings.save();

  return res.status(200).json(publicView(settings.transmission));
});

transmissionRoutes.post('/test', async (req, res, next) => {
  try {
    const api = new TransmissionAPI(resolve(req.body as TransmissionSettings));
    const { version } = await api.test();

    return res.status(200).json({ version });
  } catch (e) {
    logger.error('Failed to test Transmission', {
      label: 'Transmission',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Transmission' });
  }
});

export default transmissionRoutes;
