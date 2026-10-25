import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { isBlocked, mediaHasControls } from '@server/lib/requestControls/store';
import logger from '@server/logger';
import { Permission } from './permissions';

class WatchlistSync {
  public async syncWatchlist() {
    const userRepository = getRepository(User);

    // Get users who actually have plex tokens
    const users = await userRepository
      .createQueryBuilder('user')
      .addSelect('user.plexToken')
      .leftJoinAndSelect('user.settings', 'settings')
      .where("user.plexToken != ''")
      .getMany();

    for (const user of users) {
      await this.syncUserWatchlist(user);
    }
  }

  private async syncUserWatchlist(user: User) {
    if (!user.plexToken) {
      logger.warn('Skipping user watchlist sync for user without plex token', {
        label: 'Plex Watchlist Sync',
        user: user.displayName,
      });
      return;
    }

    if (
      !user.hasPermission(
        [
          Permission.AUTO_REQUEST,
          Permission.AUTO_REQUEST_MOVIE,
          Permission.AUTO_REQUEST_TV,
        ],
        { type: 'or' }
      )
    ) {
      return;
    }

    if (
      !user.settings?.watchlistSyncMovies &&
      !user.settings?.watchlistSyncTv
    ) {
      // Skip sync if user settings have it disabled
      return;
    }

    const plexTvApi = new PlexTvAPI(user.plexToken);

    const response = await plexTvApi.getWatchlist({ size: 20 });

    const mediaItems = await Media.getRelatedMedia(
      user,
      response.items.map((i) => ({
        tmdbId: i.tmdbId,
        mediaType: i.type === 'show' ? MediaType.TV : MediaType.MOVIE,
      }))
    );

    const watchlistTmdbIds = response.items.map((i) => i.tmdbId);

    const requestRepository = getRepository(MediaRequest);
    const existingAutoRequests: MediaRequest[] =
      watchlistTmdbIds.length > 0
        ? await requestRepository
            .createQueryBuilder('request')
            .leftJoinAndSelect('request.media', 'media')
            .where('request.requestedBy = :userId', { userId: user.id })
            .andWhere('request.isAutoRequest = true')
            .andWhere('media.tmdbId IN (:...tmdbIds)', {
              tmdbIds: watchlistTmdbIds,
            })
            .getMany()
        : [];

    const autoRequestedTmdbIds = new Set(
      existingAutoRequests
        .filter(
          (r) => r.media != null && r.media.status !== MediaStatus.DELETED
        )
        .map((r) => `${r.media.mediaType}:${r.media.tmdbId}`)
    );

    const unavailableItems = response.items.filter((i) => {
      const itemMediaType = i.type === 'show' ? MediaType.TV : MediaType.MOVIE;

      return (
        !autoRequestedTmdbIds.has(`${itemMediaType}:${i.tmdbId}`) &&
        !mediaItems.find(
          (m) =>
            m.tmdbId === i.tmdbId &&
            m.mediaType === itemMediaType &&
            (m.status === MediaStatus.BLOCKLISTED ||
              (itemMediaType === MediaType.MOVIE &&
                m.status !== MediaStatus.UNKNOWN &&
                m.status !== MediaStatus.DELETED) ||
              (itemMediaType === MediaType.TV &&
                m.status === MediaStatus.AVAILABLE))
        )
      );
    });

    for (const mediaItem of unavailableItems) {
      try {
        if (mediaItem.type === 'show' && !mediaItem.tvdbId) {
          throw new Error('Missing TVDB ID from Plex Metadata');
        }

        // Check if they have auto-request permissons and watchlist sync
        // enabled for the media type
        if (
          ((!user.hasPermission(
            [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_MOVIE],
            { type: 'or' }
          ) ||
            !user.settings?.watchlistSyncMovies) &&
            mediaItem.type === 'movie') ||
          ((!user.hasPermission(
            [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_TV],
            { type: 'or' }
          ) ||
            !user.settings?.watchlistSyncTv) &&
            mediaItem.type === 'show')
        ) {
          continue;
        }

        const seasons = await this.seasonsToRequest(mediaItem, mediaItems);
        if (seasons === null) {
          logger.debug('Skipping paused or deleted watchlist item', {
            label: 'Watchlist Sync',
            userId: user.id,
            mediaTitle: mediaItem.title,
          });
          continue;
        }

        await MediaRequest.request(
          {
            mediaId: mediaItem.tmdbId,
            mediaType:
              mediaItem.type === 'show' ? MediaType.TV : MediaType.MOVIE,
            seasons,
            tvdbId: mediaItem.tvdbId,
            is4k: false,
          },
          user,
          { isAutoRequest: true }
        );

        logger.info("Created media request from user's Plex Watchlist", {
          label: 'Watchlist Sync',
          userId: user.id,
          mediaTitle: mediaItem.title,
        });
      } catch (e) {
        if (!(e instanceof Error)) {
          continue;
        }

        switch (e.constructor) {
          // During watchlist sync, these errors aren't necessarily
          // a problem with Seerr. Since we are auto syncing these constantly, it's
          // possible they are unexpectedly at their quota limit, for example. So we'll
          // instead log these as debug messages.
          case RequestPermissionError:
          case DuplicateMediaRequestError:
          case QuotaRestrictedError:
          case NoSeasonsAvailableError:
            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Blocklisted media should be silently ignored during watchlist sync to avoid spam
          case BlocklistedMediaError:
            break;
          default:
            logger.error('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
        }
      }
    }
  }

  private async seasonsToRequest(
    item: { tmdbId: number; type: string },
    mediaItems: Media[]
  ): Promise<number[] | 'all' | undefined | null> {
    const mediaType = item.type === 'show' ? MediaType.TV : MediaType.MOVIE;
    const media = mediaItems.find(
      (m) => m.tmdbId === item.tmdbId && m.mediaType === mediaType
    );

    if (mediaType === MediaType.MOVIE) {
      return media && (await isBlocked(media.id)) ? null : undefined;
    }

    if (!media || !(await mediaHasControls(media.id))) {
      return 'all';
    }

    const show = await new TheMovieDb().getTvShow({ tvId: item.tmdbId });
    const candidates = show.seasons
      .filter(
        (season) => season.season_number !== 0 && season.episode_count > 0
      )
      .map((season) => season.season_number);
    const open: number[] = [];
    for (const seasonNumber of candidates) {
      if (!(await isBlocked(media.id, seasonNumber))) {
        open.push(seasonNumber);
      }
    }

    if (open.length === 0) {
      return null;
    }
    return open.length === candidates.length ? 'all' : open;
  }
}

const watchlistSync = new WatchlistSync();

export default watchlistSync;
