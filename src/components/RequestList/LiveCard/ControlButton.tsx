import messages from '@app/components/RequestList/LiveCard/messages';
import {
  ArrowPathIcon,
  ArrowUpIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type { ItemAction } from '@server/lib/liveStatus/types';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';

export type ButtonTone = 'default' | 'plex' | 'red' | 'amber' | 'green';

export const ACTION_LABELS: Record<ItemAction, MessageDescriptor> = {
  prioritize: messages.prioritize,
  pause: messages.pause,
  resume: messages.resume,
  delete: messages.delete,
  restore: messages.restore,
};

const ACTION_TONES: Record<ItemAction, ButtonTone> = {
  prioritize: 'default',
  pause: 'amber',
  resume: 'green',
  delete: 'red',
  restore: 'green',
};

const ACTION_ICONS: Record<
  ItemAction,
  React.ComponentType<{ className?: string }>
> = {
  prioritize: ArrowUpIcon,
  pause: PauseIcon,
  resume: PlayIcon,
  delete: TrashIcon,
  restore: ArrowPathIcon,
};

const LARGE_TONES: Record<ButtonTone, string> = {
  default: 'border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600',
  plex: 'border-[#e5a00d] bg-[#e5a00d] text-gray-900 hover:border-[#f0b53a] hover:bg-[#f0b53a]',
  red: 'border-red-800 bg-transparent text-red-300 hover:bg-red-900/40',
  amber: 'border-amber-800 bg-transparent text-amber-300 hover:bg-amber-900/40',
  green: 'border-green-800 bg-transparent text-green-300 hover:bg-green-900/40',
};

const ICON_TONES: Record<ButtonTone, string> = {
  default: 'border-gray-600 text-gray-300 hover:bg-gray-700',
  plex: 'border-[#e5a00d] text-[#e5a00d] hover:bg-gray-700',
  red: 'border-red-900 text-red-300 hover:bg-red-900/40',
  amber: 'border-amber-800 text-amber-300 hover:bg-amber-900/40',
  green: 'border-green-800 text-green-300 hover:bg-green-900/40',
};

export const largeButtonClass = (tone: ButtonTone): string =>
  `inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${LARGE_TONES[tone]}`;

const iconButtonClass = (tone: ButtonTone): string =>
  `inline-flex h-6 min-w-[1.5rem] items-center justify-center gap-1 whitespace-nowrap rounded border bg-transparent px-1 text-[11px] font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${ICON_TONES[tone]}`;

interface ControlButtonProps {
  action: ItemAction;
  label?: string;
  large?: boolean;
  showLabel?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

const ControlButton = ({
  action,
  label,
  large = false,
  showLabel = false,
  disabled = false,
  onClick,
}: ControlButtonProps) => {
  const intl = useIntl();
  const text = label ?? intl.formatMessage(ACTION_LABELS[action]);
  const Icon = ACTION_ICONS[action];
  const tone = ACTION_TONES[action];

  return (
    <button
      type="button"
      className={large ? largeButtonClass(tone) : iconButtonClass(tone)}
      title={text}
      aria-label={text}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon className={large ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      {(large || showLabel) && <span>{text}</span>}
    </button>
  );
};

export default ControlButton;
