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
});
