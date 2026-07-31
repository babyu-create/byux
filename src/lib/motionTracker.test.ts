import { describe, expect, it } from 'vitest';
import { extractPatch, findBestTemplateMatch, templateDifference } from './motionTracker';

function frame(width: number, height: number, pixels: Array<[number, number, number]>) {
  const data = new Uint8Array(width * height);
  for (const [x, y, value] of pixels) data[y * width + x] = value;
  return { width, height, data };
}

describe('motion tracker template matching', () => {
  it('extracts a bounded template and finds its translated position', () => {
    const first = frame(12, 8, [[3, 2, 255], [4, 2, 220], [3, 3, 200]]);
    const template = extractPatch(first, { x: 2 / 12, y: 1 / 8, width: 3 / 12, height: 3 / 8 });
    const next = frame(12, 8, [[5, 3, 255], [6, 3, 220], [5, 4, 200]]);
    const match = findBestTemplateMatch(next, template, 2, 1, 0.5);
    expect(match.x).toBe(4);
    expect(match.y).toBe(2);
    expect(match.confidence).toBeGreaterThan(0.9);
  });

  it('returns a full difference for an out-of-bounds candidate', () => {
    const source = frame(4, 4, [[1, 1, 255]]);
    const patch = extractPatch(source, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(templateDifference(source, patch, -1, 0)).toBe(1);
  });

  it('keeps lock when brightness changes and searches a wider recovery window', () => {
    const first = frame(24, 16, [
      [4, 5, 20], [5, 5, 80], [6, 5, 160], [7, 5, 240],
      [4, 6, 40], [5, 6, 100], [6, 6, 180], [7, 6, 220],
      [4, 7, 60], [5, 7, 120], [6, 7, 200], [7, 7, 250],
      [4, 8, 30], [5, 8, 90], [6, 8, 170], [7, 8, 230],
    ]);
    const template = extractPatch(first, { x: 4 / 24, y: 5 / 16, width: 4 / 24, height: 4 / 16 });
    const next = frame(24, 16, [
      [11, 9, 90], [12, 9, 150], [13, 9, 230], [14, 9, 255],
      [11, 10, 110], [12, 10, 170], [13, 10, 245], [14, 10, 255],
      [11, 11, 130], [12, 11, 190], [13, 11, 255], [14, 11, 255],
      [11, 12, 100], [12, 12, 160], [13, 12, 240], [14, 12, 255],
    ]);
    const match = findBestTemplateMatch(next, template, 4, 5, 0.35, {
      normalised: true,
      scales: [1],
      angles: [0],
    });
    expect(Math.abs(match.x - 11)).toBeLessThanOrEqual(1);
    expect(Math.abs(match.y - 9)).toBeLessThanOrEqual(1);
    expect(match.confidence).toBeGreaterThan(0.75);
  });
});
