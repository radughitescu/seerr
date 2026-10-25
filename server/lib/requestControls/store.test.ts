import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestItemControl } from '@server/entity/RequestItemControl';
import { User } from '@server/entity/User';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  clearControl,
  effectiveState,
  getControls,
  isBlocked,
  setControl,
} from './store';

setupTestDb();

mock.method(MediaRequest, 'sendNotification', async () => undefined);

for (const method of [
  'sendToRadarr',
  'sendToSonarr',
  'updateParentStatus',
  'handleRemoveParentUpdate',
] as const) {
  mock.method(MediaRequestSubscriber.prototype, method, async () => undefined);
}

async function seedRequest(tmdbId = 1) {
  const user = await getRepository(User).findOneOrFail({ where: { id: 1 } });
  const media = await getRepository(Media).save(
    new Media({ tmdbId, mediaType: MediaType.TV })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      media,
      requestedBy: user,
      status: MediaRequestStatus.APPROVED,
      is4k: false,
    })
  );
  return { user, media, request };
}

const key = (
  requestId: number,
  seasonNumber: number | null,
  episodeNumber: number | null
) => ({ requestId, seasonNumber, episodeNumber });

describe('request controls store', () => {
  it('setControl on a season removes episode rows of that season', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, 1, 3), 'paused', user.id);
    await setControl(key(request.id, 1, 4), 'deleted', user.id);
    await setControl(key(request.id, 2, 1), 'paused', user.id);
    await setControl(key(request.id, 1, null), 'paused', user.id);
    const rows = await getControls(request.id);
    assert.deepEqual(
      rows
        .map((r) => [r.seasonNumber, r.episodeNumber])
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
      [
        [1, null],
        [2, 1],
      ]
    );
  });

  it('setControl twice on the same season key leaves one row', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, 1, null), 'paused', user.id, 40);
    const second = await setControl(
      key(request.id, 1, null),
      'deleted',
      user.id
    );
    const rows = await getControls(request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'deleted');
    assert.equal(rows[0].id, second.id);
    assert.equal(rows[0].pausedAtPercent, null);
  });

  it('setControl twice on the whole request leaves one row', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, null, null), 'paused', user.id, 12);
    await setControl(key(request.id, null, null), 'paused', user.id, 30);
    const rows = await getControls(request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pausedAtPercent, 30);
  });

  it('effectiveState prefers episode over season over request', () => {
    const rows = [
      { seasonNumber: 1, episodeNumber: null, state: 'paused' },
      { seasonNumber: 1, episodeNumber: 4, state: 'deleted' },
    ] as RequestItemControl[];
    assert.equal(effectiveState(rows, 1, 4), 'deleted');
    assert.equal(effectiveState(rows, 1, 5), 'paused');
    assert.equal(effectiveState(rows, 2, 1), null);
    const withRequest = [
      ...rows,
      { seasonNumber: null, episodeNumber: null, state: 'paused' },
    ] as RequestItemControl[];
    assert.equal(effectiveState(withRequest, 2, 1), 'paused');
  });

  it('clearControl on request clears every row', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, null, null), 'paused', user.id);
    await setControl(key(request.id, 1, null), 'paused', user.id);
    await setControl(key(request.id, 2, 3), 'deleted', user.id);
    await clearControl(key(request.id, null, null));
    assert.equal((await getControls(request.id)).length, 0);
  });

  it('clearControl on a season clears its episodes only', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, 1, 2), 'paused', user.id);
    await setControl(key(request.id, 2, 3), 'deleted', user.id);
    await clearControl(key(request.id, 1, null));
    const rows = await getControls(request.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seasonNumber, 2);
  });

  it('isBlocked is true for an episode under a deleted season', async () => {
    const { request, media, user } = await seedRequest();
    await setControl(key(request.id, 1, null), 'deleted', user.id);
    assert.equal(await isBlocked(media.id, 1, 5), true);
    assert.equal(await isBlocked(media.id, 2, 5), false);
    assert.equal(await isBlocked(media.id), false);
  });

  it('isBlocked without a season needs a request-level row', async () => {
    const { request, media, user } = await seedRequest();
    await setControl(key(request.id, null, null), 'paused', user.id);
    assert.equal(await isBlocked(media.id), true);
    assert.equal(await isBlocked(media.id, 3, 1), true);
  });

  it('rows are removed when the request is deleted', async () => {
    const { request, user } = await seedRequest();
    await setControl(key(request.id, 1, null), 'paused', user.id);
    await getRepository(MediaRequest).delete(request.id);
    assert.equal(await getRepository(RequestItemControl).count(), 0);
  });
});
