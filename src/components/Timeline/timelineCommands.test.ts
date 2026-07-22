import { describe, expect, it, vi } from 'vitest';
import {
  consumeClipNudgeGesture,
  clipIdsIntersectingTimeRange,
  lastSelectedClipIdOnTrack,
  releasePointerCaptureIfHeld,
  timelineEditFeedback,
} from './timelineCommands';

describe('timelineEditFeedback', () => {
  it('explains that a successful destructive edit can be undone', () => {
    expect(timelineEditFeedback('delete', 2)).toEqual({
      kind: 'success',
      text: '2本のクリップを削除しました（Ctrl+Zで元に戻せます）',
    });
  });

  it('gives an actionable reason when a split changes nothing', () => {
    expect(timelineEditFeedback('split', 0)).toEqual({
      kind: 'info',
      text: '再生ヘッド位置とトラックのロックを確認してください',
    });
  });

  it('describes ripple deletion separately from ordinary deletion', () => {
    expect(timelineEditFeedback('ripple-delete', 3)).toEqual({
      kind: 'success',
      text: '3本を詰めて削除しました（Ctrl+Zで元に戻せます）',
    });
  });

  it('selects every clip intersecting a reversed horizontal time range', () => {
    const clips = [
      {
        id: 'first',
        trackId: 'video',
        assetId: 'asset',
        start: 0,
        trimStart: 0,
        trimEnd: 1,
        effects: [],
      },
      {
        id: 'second',
        trackId: 'video',
        assetId: 'asset',
        start: 1,
        trimStart: 0,
        trimEnd: 1,
        effects: [],
      },
      {
        id: 'outside',
        trackId: 'video',
        assetId: 'asset',
        start: 3,
        trimStart: 0,
        trimEnd: 1,
        effects: [],
      },
    ];

    expect(clipIdsIntersectingTimeRange(clips, 1.5, 0.5)).toEqual([
      'first',
      'second',
    ]);
    expect(clipIdsIntersectingTimeRange(clips, 2, 3)).toEqual([]);
  });

  it('finds the latest selection on a track in linear time and preserves selection order', () => {
    const clips = Array.from({ length: 10_000 }, (_, index) => ({
      id: `clip-${index}`,
    }));
    const selected = clips.map((clip) => clip.id);
    selected.push('clip-42');

    expect(lastSelectedClipIdOnTrack(clips, selected)).toBe('clip-42');
    expect(lastSelectedClipIdOnTrack(clips, ['other'])).toBe('clip-0');
    expect(lastSelectedClipIdOnTrack([], selected)).toBeUndefined();
  });

  it('consumes Alt+Arrow on the clip itself and prevents browser navigation', () => {
    const clip = new EventTarget();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    expect(
      consumeClipNudgeGesture({
        key: 'ArrowLeft',
        altKey: true,
        target: clip,
        currentTarget: clip,
        preventDefault,
        stopPropagation,
      }),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('does not steal Alt+Arrow from a nested trim slider or input', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    expect(
      consumeClipNudgeGesture({
        key: 'ArrowRight',
        altKey: true,
        target: new EventTarget(),
        currentTarget: new EventTarget(),
        preventDefault,
        stopPropagation,
      }),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('releases pointer capture exactly once when an active drag is cancelled', () => {
    const releasePointerCapture = vi.fn();
    const target = {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture,
    };
    expect(releasePointerCaptureIfHeld(target, 7)).toBe(true);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });
});
