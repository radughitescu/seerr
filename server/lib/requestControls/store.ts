import dataSource, { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { ControlState } from '@server/entity/RequestItemControl';
import { RequestItemControl } from '@server/entity/RequestItemControl';
import type { User } from '@server/entity/User';
import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';

export type { ControlState };

export type ItemKey = {
  requestId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
};

const matchOrNull = (value: number | null) =>
  value === null ? IsNull() : value;

export async function getControls(
  requestId: number
): Promise<RequestItemControl[]> {
  return getRepository(RequestItemControl).find({
    where: { request: { id: requestId } },
    order: { id: 'ASC' },
  });
}

async function clearChildren(manager: EntityManager, key: ItemKey) {
  if (key.seasonNumber === null) {
    await manager
      .createQueryBuilder()
      .delete()
      .from(RequestItemControl)
      .where('requestId = :requestId', { requestId: key.requestId })
      .andWhere('(seasonNumber IS NOT NULL OR episodeNumber IS NOT NULL)')
      .execute();
  } else if (key.episodeNumber === null) {
    await manager
      .createQueryBuilder()
      .delete()
      .from(RequestItemControl)
      .where('requestId = :requestId', { requestId: key.requestId })
      .andWhere('seasonNumber = :seasonNumber', {
        seasonNumber: key.seasonNumber,
      })
      .andWhere('episodeNumber IS NOT NULL')
      .execute();
  }
}

export async function setControl(
  key: ItemKey,
  state: ControlState,
  userId: number,
  pausedAtPercent?: number
): Promise<RequestItemControl> {
  return dataSource.transaction(async (manager) => {
    const repo = manager.getRepository(RequestItemControl);
    await clearChildren(manager, key);

    const existing = await repo.findOne({
      where: {
        request: { id: key.requestId },
        seasonNumber: matchOrNull(key.seasonNumber),
        episodeNumber: matchOrNull(key.episodeNumber),
      },
    });

    const row =
      existing ??
      new RequestItemControl({
        request: { id: key.requestId } as MediaRequest,
        seasonNumber: key.seasonNumber,
        episodeNumber: key.episodeNumber,
      });
    row.state = state;
    row.pausedAtPercent = pausedAtPercent ?? null;
    row.createdBy = { id: userId } as User;
    return repo.save(row);
  });
}

export async function clearControl(key: ItemKey): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await clearChildren(manager, key);
    await manager.getRepository(RequestItemControl).delete({
      request: { id: key.requestId },
      seasonNumber: matchOrNull(key.seasonNumber),
      episodeNumber: matchOrNull(key.episodeNumber),
    });
  });
}

export function effectiveState(
  controls: RequestItemControl[],
  seasonNumber: number | null,
  episodeNumber: number | null
): ControlState | null {
  const find = (s: number | null, e: number | null) =>
    controls.find((c) => c.seasonNumber === s && c.episodeNumber === e)?.state;

  return (
    (seasonNumber !== null && episodeNumber !== null
      ? find(seasonNumber, episodeNumber)
      : undefined) ??
    (seasonNumber !== null ? find(seasonNumber, null) : undefined) ??
    find(null, null) ??
    null
  );
}

export async function isBlocked(
  mediaId: number,
  seasonNumber?: number,
  episodeNumber?: number
): Promise<boolean> {
  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: mediaId }, is4k: false },
    select: { id: true },
    loadEagerRelations: false,
  });
  if (requests.length === 0) {
    return false;
  }

  const repo = getRepository(RequestItemControl);
  for (const request of requests) {
    const controls = await repo.find({
      where: { request: { id: request.id } },
    });
    if (
      effectiveState(controls, seasonNumber ?? null, episodeNumber ?? null) !==
      null
    ) {
      return true;
    }
  }
  return false;
}
