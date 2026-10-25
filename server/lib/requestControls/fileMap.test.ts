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

  it('maps by file basename when the directory carries SxxEyy', () => {
    const map = mapFilesToEpisodes([
      file(0, 'Show.S01E01-E08.Pack/Show.S01E05.mkv'),
    ]);
    assert.deepEqual([...map.keys()], ['1x5']);
  });

  it('skips Sample/ directory files', () => {
    const map = mapFilesToEpisodes([
      file(0, 'Show.S01E01/Sample/Show.S01E01.mkv'),
      file(1, 'Show.S01E01/Show.S01E01.sample.mkv'),
    ]);
    assert.equal(map.size, 0);
  });

  it('maps S01E01-02 to both episodes', () => {
    const map = mapFilesToEpisodes([file(0, 'Show.S01E01-02.mkv')]);
    assert.deepEqual(map.get('1x1'), [0]);
    assert.deepEqual(map.get('1x2'), [0]);
  });

  it('maps S01E01-E02 to both episodes', () => {
    const map = mapFilesToEpisodes([file(0, 'Show.S01E01-E02.mkv')]);
    assert.deepEqual(map.get('1x1'), [0]);
    assert.deepEqual(map.get('1x2'), [0]);
  });

  it('does not read a resolution as an episode range', () => {
    const map = mapFilesToEpisodes([file(0, 'Show.S01E01-720p.mkv')]);
    assert.deepEqual([...map.keys()], ['1x1']);
  });
});
