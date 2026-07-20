import { describe, expect, it, vi } from 'vitest';
import {
  consumeClipNudgeGesture,
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
