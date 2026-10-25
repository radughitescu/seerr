import ControlButton, {
  largeButtonClass,
} from '@app/components/RequestList/LiveCard/ControlButton';
import type { DeleteTarget } from '@app/components/RequestList/LiveCard/DeleteConfirmModal';
import DeleteConfirmModal from '@app/components/RequestList/LiveCard/DeleteConfirmModal';
import {
  ItemDetail,
  useItemLabel,
} from '@app/components/RequestList/LiveCard/EpisodeRow';
import type { Scope } from '@app/components/RequestList/LiveCard/format';
import {
  bulkControl,
  controlErrorInfo,
  episodeLabel,
  episodeRangeLabel,
  etaParts,
  summaryParts,
} from '@app/components/RequestList/LiveCard/format';
import messages from '@app/components/RequestList/LiveCard/messages';
import SeasonSection, {
  useSeasonName,
} from '@app/components/RequestList/LiveCard/SeasonSection';
import StatusPill, {
  ProgressBar,
} from '@app/components/RequestList/LiveCard/StatusPill';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useToasts from '@app/hooks/useToasts';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type {
  ItemAction,
  ItemState,
  RequestLiveState,
} from '@server/lib/liveStatus/types';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

export type LiveAction = (
  action: ItemAction,
  seasonNumber?: number,
  episodeNumber?: number
) => Promise<void>;

interface LiveCardProps {
  request: NonFunctionProperties<MediaRequest>;
  state: RequestLiveState | undefined;
  title?: string;
  onAction: LiveAction;
}

const LiveCard = ({ request, state, title, onAction }: LiveCardProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const itemLabel = useItemLabel();
  const seasonName = useSeasonName();
  const [busy, setBusy] = useState(false);
  const [openSeasons, setOpenSeasons] = useState<Record<number, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const { mediaUrl, mediaUrl4k } = useDeepLinks({
    mediaUrl: request.media?.mediaUrl,
    mediaUrl4k: request.media?.mediaUrl4k,
    iOSPlexUrl: request.media?.iOSPlexUrl,
    iOSPlexUrl4k: request.media?.iOSPlexUrl4k,
  });
  const plexUrl = request.is4k ? mediaUrl4k : mediaUrl;

  if (!state) {
    return null;
  }

  const isMovie = request.type === 'movie';
  const mediaTitle = title ?? '';

  const reportError = (e: unknown) => {
    const info = controlErrorInfo(
      axios.isAxiosError(e) ? e.response?.data : undefined
    );
    addToast(
      info.service && info.message
        ? intl.formatMessage(messages.serviceError, {
            service: info.service,
            message: info.message,
          })
        : info.message
          ? intl.formatMessage(messages.actionError, { message: info.message })
          : intl.formatMessage(messages.actionFailed),
      { appearance: 'error', autoDismiss: true }
    );
  };

  const runScopes = async (action: ItemAction, scopes: Scope[]) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const scope of scopes) {
        await onAction(action, scope.seasonNumber, scope.episodeNumber);
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const trigger = (action: ItemAction, target: DeleteTarget) => {
    if (action === 'delete') {
      setDeleteTarget(target);
      return;
    }
    runScopes(action, target.scopes);
  };

  const itemsTarget = (items: ItemState[]): DeleteTarget => {
    const seasonNumber = items[0]?.seasonNumber ?? 0;
    return {
      label: intl.formatMessage(messages.episodeTarget, {
        season: seasonName(seasonNumber),
        episode:
          items.length > 1
            ? episodeRangeLabel(items)
            : episodeLabel(items[0]?.episodeNumber ?? null),
      }),
      scopes: items.map((i) => ({
        seasonNumber: i.seasonNumber ?? undefined,
        episodeNumber: i.episodeNumber ?? undefined,
      })),
    };
  };

  const wholeTarget: DeleteTarget = { label: mediaTitle, scopes: [{}] };

  const firstOpen = state.seasons.find(
    (s) => s.status !== 'deleted'
  )?.seasonNumber;
  const isOpen = (seasonNumber: number) =>
    openSeasons[seasonNumber] ?? seasonNumber === firstOpen;

  const parts = summaryParts(state.summary, isMovie);
  const statusText = (() => {
    const label = itemLabel({
      status: state.summary.status,
      percent: parts.percent,
    });
    const segments = [label];
    if (parts.ready) {
      segments.push(intl.formatMessage(messages.readyCount, parts.ready));
    }
    if (parts.paused) {
      segments.push(
        intl.formatMessage(messages.pausedCount, { count: parts.paused })
      );
    }
    if (parts.deleted) {
      segments.push(
        intl.formatMessage(messages.deletedCount, { count: parts.deleted })
      );
    }
    if (parts.etaSeconds !== undefined) {
      const eta = etaParts(parts.etaSeconds);
      segments.push(
        intl.formatMessage(messages.eta, {
          eta:
            eta.unit === 'lessThanMinute'
              ? intl.formatMessage(messages.etaLessThanMinute)
              : eta.unit === 'minutes'
                ? intl.formatMessage(messages.etaMinutes, eta)
                : intl.formatMessage(messages.etaHours, eta),
        })
      );
    }
    return segments.join(' · ');
  })();

  const bulk = bulkControl(state);
  const movieActions = state.movie?.actions ?? state.actions;
  const locked = busy || !state.available;
  const dimmed = state.available ? '' : 'opacity-60';

  return (
    <div className="relative z-10 border-t border-gray-700 px-4 pb-3 pt-3 text-sm text-gray-300">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {state.available ? (
              <StatusPill status={state.summary.status} dot wrap>
                {statusText}
              </StatusPill>
            ) : (
              <StatusPill status="unavailable">
                {intl.formatMessage(messages.unavailable)}
              </StatusPill>
            )}
          </div>
          <div className={dimmed}>
            {parts.percent !== undefined && (
              <ProgressBar
                percent={parts.percent}
                status={state.summary.status}
              />
            )}
            {state.movie && (
              <ItemDetail
                status={state.movie.status}
                lastSearchedAt={state.movie.lastSearchedAt}
                error={state.movie.error}
              />
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:w-40 sm:flex-col sm:items-stretch">
          {plexUrl && (
            <a
              href={plexUrl}
              target="_blank"
              rel="noreferrer"
              className={largeButtonClass('plex')}
              title={intl.formatMessage(messages.playOnPlex)}
              aria-label={intl.formatMessage(messages.playOnPlex)}
            >
              <PlayIcon className="h-4 w-4" />
              <span>{intl.formatMessage(messages.playOnPlex)}</span>
            </a>
          )}
          {isMovie ? (
            <>
              {movieActions.includes('prioritize') && (
                <ControlButton
                  action="prioritize"
                  large
                  disabled={locked}
                  onClick={() => trigger('prioritize', wholeTarget)}
                />
              )}
              {bulk && (
                <ControlButton
                  action={bulk}
                  large
                  disabled={locked}
                  onClick={() => trigger(bulk, wholeTarget)}
                />
              )}
              {movieActions.includes('restore') && (
                <ControlButton
                  action="restore"
                  large
                  disabled={locked}
                  onClick={() => trigger('restore', wholeTarget)}
                />
              )}
              {movieActions.includes('delete') && (
                <ControlButton
                  action="delete"
                  large
                  disabled={locked}
                  onClick={() => trigger('delete', wholeTarget)}
                />
              )}
            </>
          ) : (
            <>
              {bulk && (
                <ControlButton
                  action={bulk}
                  large
                  label={intl.formatMessage(
                    bulk === 'resume' ? messages.resumeAll : messages.pauseAll
                  )}
                  disabled={locked}
                  onClick={() => trigger(bulk, wholeTarget)}
                />
              )}
              {state.actions.includes('restore') && (
                <ControlButton
                  action="restore"
                  large
                  disabled={locked}
                  onClick={() => trigger('restore', wholeTarget)}
                />
              )}
              {state.actions.includes('delete') && (
                <ControlButton
                  action="delete"
                  large
                  label={intl.formatMessage(messages.deleteRequest)}
                  disabled={locked}
                  onClick={() => trigger('delete', wholeTarget)}
                />
              )}
            </>
          )}
        </div>
      </div>
      <div className={dimmed}>
        {state.seasons.map((season) => (
          <SeasonSection
            key={`season-${season.seasonNumber}`}
            season={season}
            open={isOpen(season.seasonNumber)}
            disabled={locked}
            onToggle={() =>
              setOpenSeasons((prev) => ({
                ...prev,
                [season.seasonNumber]: !isOpen(season.seasonNumber),
              }))
            }
            onSeasonAction={(action) =>
              trigger(action, {
                label: seasonName(season.seasonNumber),
                scopes: [{ seasonNumber: season.seasonNumber }],
              })
            }
            onItemsAction={(action, items) =>
              trigger(action, itemsTarget(items))
            }
          />
        ))}
      </div>
      <DeleteConfirmModal
        requestId={request.id}
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(target) => {
          setDeleteTarget(null);
          runScopes('delete', target.scopes);
        }}
      />
    </div>
  );
};

export default LiveCard;
