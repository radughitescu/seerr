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
  requestId: number,
  manager?: EntityManager
): Promise<RequestItemControl[]> {
  const repo = manager
    ? manager.getRepository(RequestItemControl)
    : getRepository(RequestItemControl);
  return repo.find({
    where: { request: { id: requestId } },
    order: { id: 'ASC' },
  });
}

async function clearChildren(
  manager: EntityManager,
  key: ItemKey,
  keepDeleted = false
) {
  if (key.seasonNumber !== null && key.episodeNumber !== null) {
    return;
  }
  const query = manager
    .createQueryBuilder()
    .delete()
    .from(RequestItemControl)
    .where('requestId = :requestId', { requestId: key.requestId });
  if (key.seasonNumber === null) {
    query.andWhere('(seasonNumber IS NOT NULL OR episodeNumber IS NOT NULL)');
  } else {
    query
      .andWhere('seasonNumber = :seasonNumber', {
        seasonNumber: key.seasonNumber,
      })
      .andWhere('episodeNumber IS NOT NULL');
  }
  if (keepDeleted) {
    query.andWhere('state != :kept', { kept: 'deleted' });
  }
  await query.execute();
}

export async function setControl(
  key: ItemKey,
  state: ControlState,
  userId: number,
  pausedAtPercent?: number
): Promise<RequestItemControl> {
  return dataSource.transaction(async (manager) => {
    const repo = manager.getRepository(RequestItemControl);
    await clearChildren(manager, key, state !== 'deleted');

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

async function clearIn(
  manager: EntityManager,
  key: ItemKey,
  keepDeleted = false
) {
  await clearChildren(manager, key, keepDeleted);
  await manager.getRepository(RequestItemControl).delete({
    request: { id: key.requestId },
    seasonNumber: matchOrNull(key.seasonNumber),
    episodeNumber: matchOrNull(key.episodeNumber),
  });
}

export async function clearControl(key: ItemKey): Promise<void> {
  await dataSource.transaction((manager) => clearIn(manager, key));
}

export type ControlLayout = {
  seasonNumber: number;
  episodeNumbers: number[];
}[];

export async function releaseControl(
  key: ItemKey,
  layout: ControlLayout,
  options: { keepDeleted?: boolean } = {}
): Promise<void> {
  await dataSource.transaction(async (manager) => {
    const repo = manager.getRepository(RequestItemControl);
    const rows = await repo.find({
      where: { request: { id: key.requestId } },
      relations: { createdBy: true },
    });
    const find = (s: number | null, e: number | null) =>
      rows.find((r) => r.seasonNumber === s && r.episodeNumber === e);
    const spread = async (
      from: RequestItemControl,
      targets: [number, number | null][]
    ) => {
      for (const [seasonNumber, episodeNumber] of targets) {
        if (find(seasonNumber, episodeNumber)) continue;
        rows.push(
          await repo.save(
            new RequestItemControl({
              request: { id: key.requestId } as MediaRequest,
              seasonNumber,
              episodeNumber,
              state: from.state,
              pausedAtPercent: from.pausedAtPercent,
              createdBy: from.createdBy,
            })
          )
        );
      }
      await repo.delete({ id: from.id });
      rows.splice(rows.indexOf(from), 1);
    };

    if (key.seasonNumber !== null) {
      const top = find(null, null);
      if (top) {
        await spread(
          top,
          layout.map((l) => [l.seasonNumber, null])
        );
      }
      const season = find(key.seasonNumber, null);
      if (key.episodeNumber !== null && season) {
        const episodes =
          layout.find((l) => l.seasonNumber === key.seasonNumber)
            ?.episodeNumbers ?? [];
        await spread(
          season,
          episodes
            .filter((e) => e !== key.episodeNumber)
            .map((e) => [key.seasonNumber as number, e])
        );
      }
    }
    await clearIn(manager, key, options.keepDeleted ?? false);
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

export async function heldSeasons(mediaId: number): Promise<Set<number>> {
  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: mediaId }, is4k: false },
  });
  const held = new Set<number>();
  for (const request of requests) {
    const controls = await getControls(request.id);
    if (controls.length === 0) {
      continue;
    }
    for (const control of controls) {
      if (control.seasonNumber !== null) {
        held.add(control.seasonNumber);
      }
    }
    if (effectiveState(controls, null, null) !== null) {
      for (const season of request.seasons ?? []) {
        held.add(season.seasonNumber);
      }
    }
  }
  return held;
}
