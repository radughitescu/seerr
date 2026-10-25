import ControlButton from '@app/components/RequestList/LiveCard/ControlButton';
import {
  episodeLabel,
  episodeRangeLabel,
  latestSearch,
  relativeTime,
  sharedActions,
} from '@app/components/RequestList/LiveCard/format';
import messages from '@app/components/RequestList/LiveCard/messages';
import StatusPill, {
  ProgressBar,
  STATUS_LABELS,
} from '@app/components/RequestList/LiveCard/StatusPill';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid';
import type { ItemAction, ItemState } from '@server/lib/liveStatus/types';
import { useIntl } from 'react-intl';

export const useItemLabel = () => {
  const intl = useIntl();
  return (item: Pick<ItemState, 'status' | 'percent'>): string => {
    const status = intl.formatMessage(STATUS_LABELS[item.status]);
    if (item.percent === undefined || item.status === 'on_plex') return status;
    if (item.status === 'paused') {
      return intl.formatMessage(messages.pausedAt, { percent: item.percent });
    }
    return intl.formatMessage(messages.statusPercent, {
      status,
      percent: item.percent,
    });
  };
};

export const ItemDetail = ({
  status,
  lastSearchedAt,
  error,
}: {
  status: ItemState['status'];
  lastSearchedAt?: string;
  error?: string;
}) => {
  const intl = useIntl();
  if (status === 'not_found' && lastSearchedAt) {
    const { value, unit } = relativeTime(lastSearchedAt, Date.now());
    return (
      <div className="mt-0.5 truncate text-[11px] text-gray-500">
        {intl.formatMessage(messages.lastSearched, {
          time: intl.formatRelativeTime(value, unit, { numeric: 'auto' }),
        })}
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-0.5 truncate text-[11px] text-red-300" title={error}>
        {error}
      </div>
    );
  }
  return null;
};

const ROW_CLASS =
  'grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-dashed border-gray-700/70 py-1 text-xs last:border-b-0 sm:grid-cols-[2.75rem_minmax(0,1fr)_10rem_7.5rem]';

interface ActionsProps {
  actions: ItemAction[];
  disabled: boolean;
  onAction: (action: ItemAction) => void;
}

const ORDER: ItemAction[] = [
  'prioritize',
  'pause',
  'resume',
  'restore',
  'delete',
];

export const ItemActions = ({ actions, disabled, onAction }: ActionsProps) => (
  <div className="flex flex-wrap justify-end gap-1">
    {ORDER.filter((a) => actions.includes(a)).map((action) => (
      <ControlButton
        key={action}
        action={action}
        showLabel={action === 'restore'}
        disabled={disabled}
        onClick={() => onAction(action)}
      />
    ))}
  </div>
);

interface EpisodeRowProps {
  item: ItemState;
  disabled: boolean;
  nested?: boolean;
  onAction: (action: ItemAction, items: ItemState[]) => void;
}

export const EpisodeRow = ({
  item,
  disabled,
  nested,
  onAction,
}: EpisodeRowProps) => {
  const itemLabel = useItemLabel();
  return (
    <div
      className={`${ROW_CLASS} ${item.status === 'deleted' ? 'opacity-60' : ''} ${
        nested ? 'pl-3' : ''
      }`}
    >
      <span className="text-gray-400">{episodeLabel(item.episodeNumber)}</span>
      <span className="col-span-2 truncate text-gray-200 sm:col-span-1">
        {item.title}
      </span>
      <div className="col-start-2 min-w-0 sm:col-start-auto">
        <StatusPill status={item.status}>{itemLabel(item)}</StatusPill>
        {item.percent !== undefined && item.status !== 'on_plex' && (
          <ProgressBar percent={item.percent} status={item.status} mini />
        )}
        <ItemDetail
          status={item.status}
          lastSearchedAt={item.lastSearchedAt}
          error={item.error}
        />
      </div>
      <ItemActions
        actions={item.actions}
        disabled={disabled}
        onAction={(action) => onAction(action, [item])}
      />
    </div>
  );
};

interface EpisodeGroupRowProps {
  items: ItemState[];
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onAction: (action: ItemAction, items: ItemState[]) => void;
}

export const EpisodeGroupRow = ({
  items,
  expanded,
  disabled,
  onToggle,
  onAction,
}: EpisodeGroupRowProps) => {
  const intl = useIntl();
  const itemLabel = useItemLabel();
  const first = items[0];
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <>
      <div
        className={`${ROW_CLASS} ${first.status === 'deleted' ? 'opacity-60' : ''}`}
      >
        <button
          type="button"
          className="col-span-3 flex min-w-0 items-center gap-2 text-left hover:text-white sm:col-span-2"
          onClick={onToggle}
          aria-expanded={expanded}
          title={intl.formatMessage(
            expanded ? messages.collapse : messages.expand
          )}
        >
          <span className="w-[2.75rem] flex-shrink-0 text-gray-400">
            {episodeRangeLabel(items)}
          </span>
          <span className="flex min-w-0 items-center gap-1 truncate text-gray-400">
            {intl.formatMessage(messages.episodeCount, {
              count: items.length,
            })}
            <Chevron className="h-3 w-3 flex-shrink-0" />
          </span>
        </button>
        <div className="col-start-2 min-w-0 sm:col-start-auto">
          <StatusPill status={first.status}>{itemLabel(first)}</StatusPill>
          <ItemDetail
            status={first.status}
            lastSearchedAt={latestSearch(items)}
          />
        </div>
        <ItemActions
          actions={sharedActions(items)}
          disabled={disabled}
          onAction={(action) => onAction(action, items)}
        />
      </div>
      {expanded &&
        items.map((item) => (
          <EpisodeRow
            key={`ep-${item.episodeNumber}`}
            item={item}
            disabled={disabled}
            nested
            onAction={onAction}
          />
        ))}
    </>
  );
};

export default EpisodeRow;
