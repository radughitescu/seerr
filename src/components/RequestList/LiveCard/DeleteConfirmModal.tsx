import Modal from '@app/components/Common/Modal';
import type { Scope } from '@app/components/RequestList/LiveCard/format';
import {
  controlErrorInfo,
  mergePreviews,
  previewEpisodes,
} from '@app/components/RequestList/LiveCard/format';
import messages from '@app/components/RequestList/LiveCard/messages';
import { formatBytes } from '@app/utils/numberHelpers';
import { Transition } from '@headlessui/react';
import type { DeletePreview } from '@server/lib/requestControls/preview';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

export type DeleteTarget = { label: string; scopes: Scope[] };

const loadPreview = async (
  requestId: number,
  scopes: Scope[]
): Promise<DeletePreview> => {
  const previews: DeletePreview[] = [];
  for (const scope of scopes) {
    const { data } = await axios.get<DeletePreview>(
      `/api/v1/request/${requestId}/control/delete-preview`,
      {
        params: {
          seasonNumber: scope.seasonNumber,
          episodeNumber: scope.episodeNumber,
        },
      }
    );
    previews.push(data);
  }
  return mergePreviews(previews);
};

interface DeleteBodyProps {
  requestId: number;
  target: DeleteTarget;
  onCancel: () => void;
  onConfirm: () => void;
}

const DeleteBody = ({
  requestId,
  target,
  onCancel,
  onConfirm,
}: DeleteBodyProps) => {
  const intl = useIntl();
  const [preview, setPreview] = useState<DeletePreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    loadPreview(requestId, target.scopes)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((e) => {
        if (!active) return;
        const info = controlErrorInfo(
          axios.isAxiosError(e) ? e.response?.data : undefined
        );
        setError(
          [info.service, info.message ?? (e as Error).message]
            .filter(Boolean)
            .join(': ')
        );
      });
    return () => {
      active = false;
    };
  }, [requestId, target]);

  const episodes = preview ? previewEpisodes(preview) : [];

  return (
    <Modal
      title={intl.formatMessage(messages.deleteTitle, {
        target: target.label,
      })}
      loading={!preview && !error}
      onCancel={onCancel}
      cancelText={intl.formatMessage(messages.keep)}
      onOk={onConfirm}
      okText={intl.formatMessage(messages.delete)}
      okButtonType="danger"
      okDisabled={!preview}
    >
      {error ? (
        <p className="text-red-300">
          {intl.formatMessage(messages.deletePreviewFailed, {
            message: error,
          })}
        </p>
      ) : preview ? (
        <div className="space-y-2">
          <p>
            {preview.files.length > 0
              ? intl.formatMessage(messages.deleteFiles, {
                  count: preview.files.length,
                })
              : intl.formatMessage(messages.deleteNoFiles)}
          </p>
          {episodes.length > 0 && (
            <p className="break-words">
              {intl.formatMessage(messages.deleteEpisodes, {
                episodes: episodes.join(', '),
              })}
            </p>
          )}
          <p className="font-semibold text-white">
            {intl.formatMessage(messages.deleteFreed, {
              size: formatBytes(preview.bytesFreed, 1),
            })}
          </p>
          {preview.torrentKept && (
            <p className="text-amber-300">
              {intl.formatMessage(messages.deleteTorrentKept)}
            </p>
          )}
          <p className="text-gray-400">
            {intl.formatMessage(messages.deleteRestoreHint)}
          </p>
        </div>
      ) : null}
    </Modal>
  );
};

interface DeleteConfirmModalProps {
  requestId: number;
  target: DeleteTarget | null;
  onCancel: () => void;
  onConfirm: (target: DeleteTarget) => void;
}

const DeleteConfirmModal = ({
  requestId,
  target,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps) => (
  <Transition
    as="div"
    enter="transition-opacity duration-300"
    enterFrom="opacity-0"
    enterTo="opacity-100"
    leave="transition-opacity duration-300"
    leaveFrom="opacity-100"
    leaveTo="opacity-0"
    show={!!target}
  >
    {target && (
      <DeleteBody
        requestId={requestId}
        target={target}
        onCancel={onCancel}
        onConfirm={() => onConfirm(target)}
      />
    )}
  </Transition>
);

export default DeleteConfirmModal;
