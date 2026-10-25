import {
  EpisodeGroupRow,
  EpisodeRow,
  ItemActions,
} from '@app/components/RequestList/LiveCard/EpisodeRow';
import { groupEpisodes } from '@app/components/RequestList/LiveCard/format';
import messages from '@app/components/RequestList/LiveCard/messages';
import StatusPill, {
  STATUS_LABELS,
} from '@app/components/RequestList/LiveCard/StatusPill';
import globalMessages from '@app/i18n/globalMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid';
import type {
  ItemAction,
  ItemState,
  SeasonState,
} from '@server/lib/liveStatus/types';
import { useState } from 'react';
import { useIntl } from 'react-intl';

export const useSeasonName = () => {
  const intl = useIntl();
  return (seasonNumber: number): string =>
    seasonNumber === 0
      ? intl.formatMessage(globalMessages.specials)
      : intl.formatMessage(messages.season, { seasonNumber });
};

interface SeasonSectionProps {
  season: SeasonState;
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onSeasonAction: (action: ItemAction) => void;
  onItemsAction: (action: ItemAction, items: ItemState[]) => void;
}

const SeasonSection = ({
  season,
  open,
  disabled,
  onToggle,
  onSeasonAction,
  onItemsAction,
}: SeasonSectionProps) => {
  const intl = useIntl();
  const seasonName = useSeasonName();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const deleted = season.status === 'deleted';
  const ready = season.episodes.filter((e) => e.status === 'on_plex').length;
  const total = season.episodes.length;
  const since =
    (season.status === 'deleted' || season.status === 'paused') &&
    season.controlSince
      ? intl.formatMessage(
          deleted ? messages.seasonDeletedSince : messages.seasonPausedSince,
          {
            date: intl.formatDate(season.controlSince, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          }
        )
      : undefined;

  const releaseParts = season.release
    ? [
        season.release.name,
        formatBytes(season.release.sizeBytes, 1),
        intl.formatMessage(messages.peers, { count: season.release.peers }),
        ...(season.release.rateBytes > 0
          ? [
              intl.formatMessage(messages.rate, {
                rate: formatBytes(season.release.rateBytes, 1),
              }),
            ]
          : []),
      ]
    : [];

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <div className="mt-2.5 border-t border-gray-700 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-left ${
            deleted ? 'opacity-60' : ''
          }`}
          onClick={onToggle}
          aria-expanded={open}
        >
          <Chevron className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
          <span className="text-[13px] font-bold text-white">
            {seasonName(season.seasonNumber)}
          </span>
          {since ? (
            <StatusPill status={season.status}>{since}</StatusPill>
          ) : (
            !open && (
              <StatusPill status={season.status}>
                {intl.formatMessage(
                  deleted ? messages.seasonDeleted : messages.seasonStatus,
                  {
                    status: intl.formatMessage(STATUS_LABELS[season.status]),
                    ready,
                    total,
                  }
                )}
              </StatusPill>
            )
          )}
          {open && releaseParts.length > 0 && (
            <span
              className="min-w-0 truncate text-xs text-gray-400"
              title={releaseParts.join(' · ')}
            >
              · {releaseParts.join(' · ')}
            </span>
          )}
        </button>
        <ItemActions
          actions={season.actions}
          disabled={disabled}
          onAction={onSeasonAction}
        />
      </div>
      {open && (
        <div className="mt-1">
          {groupEpisodes(season.episodes).map((group) =>
            group.kind === 'single' ? (
              <EpisodeRow
                key={`ep-${group.item.episodeNumber}`}
                item={group.item}
                disabled={disabled}
                onAction={onItemsAction}
              />
            ) : (
              <EpisodeGroupRow
                key={`group-${group.key}`}
                items={group.items}
                expanded={expandedGroups.has(group.key)}
                disabled={disabled}
                onToggle={() => toggleGroup(group.key)}
                onAction={onItemsAction}
              />
            )
          )}
        </div>
      )}
    </div>
  );
};

export default SeasonSection;
