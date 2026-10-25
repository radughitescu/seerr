import { applyDelta } from '@server/lib/liveStatus/delta';
import type { LiveDelta, RequestLiveState } from '@server/lib/liveStatus/types';
import { useCallback, useEffect, useState } from 'react';

export const MAX_LIVE_IDS = 50;

type LiveStates = Record<number, RequestLiveState>;

export const liveIdsKey = (ids: number[]): string =>
  [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))]
    .slice(0, MAX_LIVE_IDS)
    .sort((a, b) => a - b)
    .join(',');

export function applyLiveDeltas(
  states: LiveStates,
  deltas: LiveDelta[]
): LiveStates {
  let next = states;
  for (const delta of deltas) {
    const current = next[delta.requestId];
    if (!current && delta.path.length > 0) continue;
    const updated = current
      ? applyDelta(current, delta)
      : (delta.value as RequestLiveState);
    next = { ...next, [delta.requestId]: updated };
  }
  return next;
}

const useLiveRequests = (ids: number[]) => {
  const [states, setStates] = useState<LiveStates>({});
  const [connected, setConnected] = useState(false);
  const key = liveIdsKey(ids);

  useEffect(() => {
    if (!key) {
      setConnected(false);
      return;
    }

    const source = new EventSource(`/api/v1/request/live?ids=${key}`, {
      withCredentials: true,
    });

    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const state = JSON.parse(event.data) as RequestLiveState;
        setStates((prev) => ({ ...prev, [state.requestId]: state }));
      } catch {
        return;
      }
    };

    const onDelta = (event: MessageEvent<string>) => {
      try {
        const deltas = JSON.parse(event.data) as LiveDelta[];
        setStates((prev) => applyLiveDeltas(prev, deltas));
      } catch {
        return;
      }
    };

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('snapshot', onSnapshot);
    source.addEventListener('delta', onDelta);

    return () => {
      source.removeEventListener('snapshot', onSnapshot);
      source.removeEventListener('delta', onDelta);
      source.close();
      setConnected(false);
    };
  }, [key]);

  const replaceState = useCallback((state: RequestLiveState) => {
    setStates((prev) => ({ ...prev, [state.requestId]: state }));
  }, []);

  return { states, connected, replaceState };
};

export default useLiveRequests;
