import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapFilesToEpisodes } from './fileMap';

const file = (index: number, name: string) => ({
  index,
  name,
  length: 100,
  bytesCompleted: 0,
});

describe('mapFilesToEpisodes', () => {
  it('maps S01E04 to [index]', () => {
    const map = mapFilesToEpisodes([file(3, 'Show/Show.S01E04.1080p.mkv')]);
    assert.deepEqual(map.get('1x4'), [3]);
  });

  it('maps S01E01E02 to both episodes', () => {
    const map = mapFilesToEpisodes([file(0, 'Show.S01E01E02.mkv')]);
    assert.deepEqual(map.get('1x1'), [0]);
    assert.deepEqual(map.get('1x2'), [0]);
  });

  it('maps "s1.e05" style', () => {
    const map = mapFilesToEpisodes([file(7, 'show.s1.e05.mkv')]);
    assert.deepEqual(map.get('1x5'), [7]);
  });

  it('ignores sample/ nfo files without SxxEyy', () => {
    const map = mapFilesToEpisodes([
      file(0, 'Show/Sample/sample.mkv'),
      file(1, 'Show/show.nfo'),
    ]);
    assert.equal(map.size, 0);
  });
});
