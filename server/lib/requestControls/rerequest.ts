import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { ControlState } from '@server/entity/RequestItemControl';
import type { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { actions } from './actions';
import { effectiveState, getControls } from './store';

export type ReRequestResult = {
  request: MediaRequest;
  remainingSeasons: number[];
};

const actionFor = (state: ControlState) =>
  state === 'paused' ? 'resume' : 'restore';

function canRequest(user: User, mediaType: MediaType, is4k: boolean) {
  const permissions =
    mediaType === MediaType.MOVIE
      ? is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
        : [Permission.REQUEST, Permission.REQUEST_MOVIE]
      : is4k
        ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
        : [Permission.REQUEST, Permission.REQUEST_TV];
  return user.hasPermission(permissions, { type: 'or' });
}

async function allSeasons(tmdbId: number): Promise<number[]> {
  const show = await new TheMovieDb().getTvShow({ tvId: tmdbId });
  const seasons = show.seasons
    .filter((season) => season.season_number !== 0 && season.episode_count > 0)
    .map((season) => season.season_number);
  return getSettings().main.enableSpecialEpisodes
    ? seasons
    : seasons.filter((seasonNumber) => seasonNumber > 0);
}

const reload = (request: MediaRequest) =>
  getRepository(MediaRequest).findOneOrFail({ where: { id: request.id } });

export async function reRequestControlled(
  body: MediaRequestBody,
  user: User
): Promise<ReRequestResult | null> {
  if (body.mediaType !== MediaType.MOVIE && body.mediaType !== MediaType.TV) {
    return null;
  }
  const is4k = !!body.is4k;
  if (!canRequest(user, body.mediaType, is4k)) {
    return null;
  }

  const media = await getRepository(Media).findOne({
    where: { tmdbId: body.mediaId, mediaType: body.mediaType },
  });
  if (!media || media.status === MediaStatus.BLOCKLISTED) {
    return null;
  }

  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: media.id }, is4k },
    order: { id: 'ASC' },
  });

  const wanted = Array.isArray(body.seasons) ? body.seasons : null;
  const covered = new Set<number>();
  let converted: MediaRequest | null = null;

  for (const request of requests) {
    const controls = await getControls(request.id);
    if (controls.length === 0) {
      continue;
    }

    if (body.mediaType === MediaType.MOVIE) {
      const state = effectiveState(controls, null, null);
      if (state === null) {
        continue;
      }
      await actions.runAction({
        request,
        action: actionFor(state),
        seasonNumber: null,
        episodeNumber: null,
        user,
      });
      converted ??= request;
      continue;
    }

    const seasons = request.seasons
      .map((season) => season.seasonNumber)
      .filter(
        (seasonNumber) =>
          (wanted === null || wanted.includes(seasonNumber)) &&
          effectiveState(controls, seasonNumber, null) !== null
      );
    if (seasons.length === 0) {
      continue;
    }

    const top = effectiveState(controls, null, null);
    if (top !== null) {
      await actions.runAction({
        request,
        action: actionFor(top),
        seasonNumber: null,
        episodeNumber: null,
        user,
      });
    }

    const current = top !== null ? await getControls(request.id) : controls;
    for (const seasonNumber of seasons) {
      const state = effectiveState(current, seasonNumber, null);
      if (state !== null) {
        await actions.runAction({
          request,
          action: actionFor(state),
          seasonNumber,
          episodeNumber: null,
          user,
        });
      }
      covered.add(seasonNumber);
    }
    converted ??= request;
  }

  if (!converted) {
    return null;
  }

  const requested =
    body.mediaType === MediaType.MOVIE
      ? []
      : (wanted ?? (await allSeasons(body.mediaId)));

  return {
    request: await reload(converted),
    remainingSeasons: requested.filter(
      (seasonNumber) => !covered.has(seasonNumber)
    ),
  };
}
