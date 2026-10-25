import type { LiveDelta, RequestLiveState } from './types';

type Path = (string | number)[];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(
  prev: unknown,
  next: unknown,
  path: Path,
  out: { path: Path; value: unknown }[]
) {
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) {
      out.push({ path, value: next });
      return;
    }
    next.forEach((item, i) => walk(prev[i], item, [...path, i], out));
    return;
  }

  if (isObject(prev) && isObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of keys) {
      const inNext = key in next && next[key] !== undefined;
      const inPrev = key in prev && prev[key] !== undefined;
      if (!inNext && !inPrev) {
        continue;
      }
      if (!inNext) {
        out.push({ path: [...path, key], value: undefined });
      } else if (!inPrev) {
        out.push({ path: [...path, key], value: next[key] });
      } else {
        walk(prev[key], next[key], [...path, key], out);
      }
    }
    return;
  }

  if (prev !== next) {
    out.push({ path, value: next });
  }
}

export function diffSnapshots(
  prev: RequestLiveState | undefined,
  next: RequestLiveState
): LiveDelta[] {
  if (!prev) {
    return [{ requestId: next.requestId, path: [], value: next }];
  }
  const out: { path: Path; value: unknown }[] = [];
  walk(prev, next, [], out);
  if (out.every((d) => d.path.length === 1 && d.path[0] === 'updatedAt')) {
    return [];
  }
  return out.map((d) => ({ requestId: next.requestId, ...d }));
}

function setIn(node: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...rest] = path;
  if (Array.isArray(node)) {
    const copy = node.slice();
    copy[head as number] = setIn(node[head as number], rest, value);
    return copy;
  }
  const base = isObject(node) ? node : {};
  const copy: Record<string, unknown> = { ...base };
  const updated = setIn(base[head as string], rest, value);
  if (updated === undefined && rest.length === 0) {
    delete copy[head as string];
  } else {
    copy[head as string] = updated;
  }
  return copy;
}

export function applyDelta(
  state: RequestLiveState,
  d: LiveDelta
): RequestLiveState {
  return setIn(state, d.path, d.value) as RequestLiveState;
}
