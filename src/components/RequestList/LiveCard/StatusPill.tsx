import messages from '@app/components/RequestList/LiveCard/messages';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type { ItemStatus } from '@server/lib/liveStatus/types';
import type { MessageDescriptor } from 'react-intl';

export const STATUS_LABELS: Record<ItemStatus, MessageDescriptor> = {
  searching: messages.searching,
  not_found: messages.notFound,
  queued: messages.queued,
  downloading: messages.downloading,
  stalled: messages.stalled,
  paused: messages.paused,
  importing: messages.importing,
  on_plex: messages.onPlex,
  deleted: messages.deleted,
  failed: messages.failed,
  unknown: messages.unknown,
};

const PILL_COLORS: Record<ItemStatus | 'unavailable', string> = {
  searching: 'bg-yellow-900 text-yellow-200',
  not_found: 'bg-red-900 text-red-200',
  queued: 'bg-gray-700 text-gray-300',
  downloading: 'bg-indigo-900 text-indigo-200',
  stalled: 'bg-red-900 text-red-200',
  paused: 'bg-amber-900 text-amber-200',
  importing: 'bg-indigo-900 text-indigo-200',
  on_plex: 'bg-green-900 text-green-200',
  deleted: 'bg-red-950 text-red-300',
  failed: 'bg-red-900 text-red-200',
  unknown: 'bg-gray-700 text-gray-300',
  unavailable: 'bg-gray-700 text-gray-300',
};

export const BAR_COLORS: Partial<Record<ItemStatus, string>> = {
  paused: 'bg-amber-600',
  stalled: 'bg-red-500',
};

interface StatusPillProps {
  status: ItemStatus | 'unavailable';
  dot?: boolean;
  title?: string;
  wrap?: boolean;
  children: React.ReactNode;
}

const StatusPill = ({
  status,
  dot,
  title,
  wrap = false,
  children,
}: StatusPillProps) => {
  const icon =
    status === 'on_plex' ? (
      <CheckIcon className="h-3 w-3 flex-shrink-0" />
    ) : status === 'paused' ? (
      <PauseIcon className="h-3 w-3 flex-shrink-0" />
    ) : status === 'deleted' ? (
      <TrashIcon className="h-3 w-3 flex-shrink-0" />
    ) : status === 'unavailable' ? (
      <ExclamationTriangleIcon className="h-3 w-3 flex-shrink-0" />
    ) : dot ? (
      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current" />
    ) : null;

  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 px-2 py-0.5 text-[11px] font-semibold leading-4 ${
        wrap ? 'rounded-xl' : 'truncate whitespace-nowrap rounded-full'
      } ${PILL_COLORS[status]}`}
      title={title}
    >
      {icon}
      <span className={wrap ? '' : 'truncate'}>{children}</span>
    </span>
  );
};

export const ProgressBar = ({
  percent,
  status,
  mini,
}: {
  percent: number;
  status: ItemStatus;
  mini?: boolean;
}) => (
  <div
    className={`overflow-hidden rounded bg-gray-700 ${
      mini ? 'mt-1 h-1' : 'my-1.5 h-1.5'
    }`}
    role="progressbar"
    aria-valuenow={percent}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      className={`h-full transition-all duration-500 ${
        BAR_COLORS[status] ?? 'bg-indigo-500'
      }`}
      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
    />
  </div>
);

export default StatusPill;
