import type { TorrentInfo } from '@server/api/transmission';

const EPISODE_PATTERN = /S(\d{1,2})((?:[ ._-]?E\d{1,3})+)/i;

export function mapFilesToEpisodes(
  files: TorrentInfo['files']
): Map<string, number[]> {
  const result = new Map<string, number[]>();

  for (const file of files) {
    const match = EPISODE_PATTERN.exec(file.name);
    if (!match) {
      continue;
    }
    const season = Number(match[1]);
    for (const ep of match[2].matchAll(/E(\d{1,3})/gi)) {
      const key = `${season}x${Number(ep[1])}`;
      const indexes = result.get(key) ?? [];
      indexes.push(file.index);
      result.set(key, indexes);
    }
  }

  return result;
}
