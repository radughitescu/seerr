import type { TorrentInfo } from '@server/api/transmission';

const EPISODE_PATTERN =
  /S(\d{1,2})((?:[ ._-]?E\d{1,3}|-\d{1,3}(?![\dpPiIkK]))+)/i;
const SAMPLE_NAME = /[._-]sample[._-]/i;

export function mapFilesToEpisodes(
  files: TorrentInfo['files']
): Map<string, number[]> {
  const result = new Map<string, number[]>();

  for (const file of files) {
    const segments = file.name.split(/[\\/]/);
    const basename = segments[segments.length - 1];
    if (
      segments.slice(0, -1).some((s) => s.toLowerCase() === 'sample') ||
      SAMPLE_NAME.test(basename)
    ) {
      continue;
    }
    const match = EPISODE_PATTERN.exec(basename);
    if (!match) {
      continue;
    }
    const season = Number(match[1]);
    for (const ep of match[2].matchAll(/(?:E|-)(\d{1,3})/gi)) {
      const key = `${season}x${Number(ep[1])}`;
      const indexes = result.get(key) ?? [];
      indexes.push(file.index);
      result.set(key, indexes);
    }
  }

  return result;
}
