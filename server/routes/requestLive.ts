import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { liveStatusHub } from '@server/lib/liveStatus/hub';
import type { ItemAction } from '@server/lib/liveStatus/types';
import { Permission } from '@server/lib/permissions';
import {
  ActionError,
  actions,
  ServiceError,
} from '@server/lib/requestControls/actions';
import { previews } from '@server/lib/requestControls/preview';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import type { NextFunction, Response } from 'express';
import { Router } from 'express';
import { In } from 'typeorm';

export const MAX_LIVE_IDS = 50;
export const HEARTBEAT_MS = 15000;

const ACTIONS: ItemAction[] = [
  'prioritize',
  'pause',
  'resume',
  'delete',
  'restore',
];

const IDS_PATTERN = /^[1-9]\d*(,[1-9]\d*)*$/;

export function canViewRequest(
  user: User | undefined,
  request: MediaRequest
): boolean {
  if (!user) return false;
  return (
    request.requestedBy?.id === user.id ||
    user.hasPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], {
      type: 'or',
    })
  );
}

const optionalNumber = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
};

const parseRequestId = (value: string): number | undefined => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

async function loadVisibleRequest(
  rawId: string,
  user: User | undefined,
  next: NextFunction
): Promise<MediaRequest | undefined> {
  const id = parseRequestId(rawId);
  const request = id
    ? await getRepository(MediaRequest).findOne({ where: { id } })
    : null;
  if (!request) {
    next({ status: 404, message: 'Request not found.' });
    return undefined;
  }
  if (!canViewRequest(user, request)) {
    next({
      status: 403,
      message: 'You do not have permission to view this request.',
    });
    return undefined;
  }
  return request;
}

function handleActionError(e: unknown, res: Response, next: NextFunction) {
  if (e instanceof ServiceError) {
    return res.status(502).json({ service: e.service, message: e.message });
  }
  if (e instanceof ActionError) {
    return next({ status: e.status, message: e.message });
  }
  logger.error('Request control failed', {
    label: 'Request Controls',
    errorMessage: e instanceof Error ? e.message : String(e),
  });
  return next({ status: 500, message: 'Request control failed.' });
}

const requestLiveRoutes = Router();

requestLiveRoutes.get('/live', isAuthenticated(), async (req, res, next) => {
  const raw = req.query.ids;
  if (typeof raw !== 'string' || !IDS_PATTERN.test(raw)) {
    return next({
      status: 400,
      message: 'ids must be a comma-separated list of positive integers.',
    });
  }
  const parts = raw.split(',');
  if (parts.length > MAX_LIVE_IDS) {
    return next({
      status: 400,
      message: `At most ${MAX_LIVE_IDS} ids are allowed.`,
    });
  }
  const ids = [...new Set(parts.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    return next({ status: 400, message: 'ids must be positive integers.' });
  }

  let visible: number[];
  try {
    const requests = await getRepository(MediaRequest).find({
      where: { id: In(ids) },
    });
    visible = requests
      .filter((r) => canViewRequest(req.user, r))
      .map((r) => r.id);
  } catch (e) {
    logger.error('Failed to load requests for live status', {
      label: 'Request Controls',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
    return next({ status: 500, message: 'Unable to load requests.' });
  }

  if (res.destroyed || req.socket.destroyed) {
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const write = (chunk: string) => {
    if (closed || res.writableEnded || res.destroyed) return;
    res.write(chunk);
  };
  const send = (event: 'snapshot' | 'delta', data: unknown) =>
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const unsubscribe = visible.length
    ? liveStatusHub.subscribe(visible, (e) => {
        if (e.type === 'snapshot') {
          send('snapshot', e.state);
        } else {
          send('delta', e.deltas);
        }
      })
    : () => undefined;

  const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
});

requestLiveRoutes.post<{ requestId: string }>(
  '/:requestId/control',
  isAuthenticated(),
  async (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = body.action as ItemAction;
    const seasonNumber = optionalNumber(body.seasonNumber);
    const episodeNumber = optionalNumber(body.episodeNumber);
    if (
      !ACTIONS.includes(action) ||
      seasonNumber === undefined ||
      episodeNumber === undefined
    ) {
      return next({ status: 400, message: 'Invalid control request.' });
    }

    try {
      const request = await loadVisibleRequest(
        req.params.requestId,
        req.user,
        next
      );
      if (!request || !req.user) return;
      const state = await actions.runAction({
        request,
        action,
        seasonNumber,
        episodeNumber,
        user: req.user,
      });
      return res.status(200).json(state);
    } catch (e) {
      return handleActionError(e, res, next);
    }
  }
);

requestLiveRoutes.get<{ requestId: string }>(
  '/:requestId/control/delete-preview',
  isAuthenticated(),
  async (req, res, next) => {
    const seasonNumber = optionalNumber(req.query.seasonNumber);
    const episodeNumber = optionalNumber(req.query.episodeNumber);
    if (seasonNumber === undefined || episodeNumber === undefined) {
      return next({ status: 400, message: 'Invalid season or episode.' });
    }

    try {
      const request = await loadVisibleRequest(
        req.params.requestId,
        req.user,
        next
      );
      if (!request) return;
      const preview = await previews.getDeletePreview(
        request,
        seasonNumber,
        episodeNumber
      );
      return res.status(200).json(preview);
    } catch (e) {
      return handleActionError(e, res, next);
    }
  }
);

export default requestLiveRoutes;
