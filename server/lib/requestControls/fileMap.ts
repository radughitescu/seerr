import type { TorrentInfo } from '@server/api/transmission';

const EPISODE_PATTERN =
  /S(\d{1,2})((?:[ ._-]?E\d{1,3}|-\d{1,3}(?![\dpPiIkK]))+)/i;
const SAMPLE_NAME = /[._-]sample[._-]/i;
const EXTRA_EXTENSION =
  /\.(nfo|txt|jpe?g|png|gif|bmp|webp|srt|sub|idx|ass|ssa|vtt|sup|sfv|md5|sha1|url|nzb|torrent|html?|db|ini|xml)$/i;

const splitName = (name: string) => {
  const segments = name.split(/[\\/]/);
  return {
    dirs: segments.slice(0, -1),
    basename: segments[segments.length - 1],
  };
};

export function isSampleFile(name: string): boolean {
  const { dirs, basename } = splitName(name);
  return (
    dirs.some((s) => s.toLowerCase() === 'sample') || SAMPLE_NAME.test(basename)
  );
}

export function isExtraFile(name: string): boolean {
  return isSampleFile(name) || EXTRA_EXTENSION.test(splitName(name).basename);
}

export function mapFilesToEpisodes(
  files: TorrentInfo['files']
): Map<string, number[]> {
  const result = new Map<string, number[]>();

  for (const file of files) {
    if (isSampleFile(file.name)) {
      continue;
    }
    const { basename } = splitName(file.name);
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
