import { useProjectStore } from '../../stores/projectStore';
import type { Clip } from '../../lib/types';
import { clipDuration } from '../../lib/timeline';

export type TimelineEditOperation = 'split' | 'delete' | 'ripple-delete';

interface ClipNudgeEvent {
  key: string;
  altKey: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Consume only Alt+horizontal-arrow on the clip container itself.
 * Nested sliders keep their native/trim arrow behavior.
 */
export function consumeClipNudgeGesture(event: ClipNudgeEvent): boolean {
  if (
    !event.altKey ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
    event.target !== event.currentTarget
  ) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

interface PointerCaptureTarget {
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
}

export function releasePointerCaptureIfHeld(
  target: PointerCaptureTarget,
  pointerId: number,
): boolean {
  if (!target.hasPointerCapture(pointerId)) return false;
  target.releasePointerCapture(pointerId);
  return true;
}

/** Clip ids touched by a horizontal marquee, in project order. */
export function clipIdsIntersectingTimeRange(
  clips: readonly Clip[],
  firstTime: number,
  secondTime: number,
): string[] {
  const start = Math.max(0, Math.min(firstTime, secondTime));
  const end = Math.max(0, Math.max(firstTime, secondTime));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 1e-6) {
    return [];
  }
  return clips
    .filter((clip) => {
      const clipEnd = clip.start + clipDuration(clip);
      return clipEnd > start + 1e-6 && clip.start < end - 1e-6;
    })
    .map((clip) => clip.id);
}

/**
 * Return the most recently selected clip that belongs to this track without
 * multiplying selected-count by track-clip-count. Ctrl/Cmd+A can select the
 * full 10,000-clip project, so the former nested `find(some())` became a
 * visible main-thread stall.
 */
export function lastSelectedClipIdOnTrack(
  orderedClips: readonly Pick<Clip, 'id'>[],
  selectedClipIds: readonly string[],
): string | undefined {
  const trackClipIds = new Set(orderedClips.map((clip) => clip.id));
  for (let index = selectedClipIds.length - 1; index >= 0; index -= 1) {
    const id = selectedClipIds[index];
    if (trackClipIds.has(id)) return id;
  }
  return orderedClips[0]?.id;
}

export function timelineEditFeedback(
  operation: TimelineEditOperation,
  changedCount: number,
): { kind: 'success' | 'info'; text: string } {
  if (changedCount > 0) {
    return {
      kind: 'success',
      text:
        operation === 'split'
          ? `${changedCount}本のクリップを分割しました（Ctrl+Zで元に戻せます）`
          : operation === 'ripple-delete'
            ? `${changedCount}本を詰めて削除しました（Ctrl+Zで元に戻せます）`
          : `${changedCount}本のクリップを削除しました（Ctrl+Zで元に戻せます）`,
    };
  }
  return {
    kind: 'info',
    text:
      operation === 'split'
        ? '再生ヘッド位置とトラックのロックを確認してください'
        : operation === 'ripple-delete'
          ? '詰めて削除できるクリップがありません（トラックのロックを確認してください）'
        : '選択クリップは削除できません（トラックのロックを確認してください）',
  };
}

function showEditFeedback(
  operation: TimelineEditOperation,
  changedCount: number,
): number {
  const feedback = timelineEditFeedback(operation, changedCount);
  useProjectStore.getState().showMessage(feedback.kind, feedback.text, 3200);
  return changedCount;
}

export function splitSelectedWithFeedback(): number {
  const before = useProjectStore.getState().clips.length;
  useProjectStore.getState().splitSelectedAtPlayhead();
  const changedCount = Math.max(
    0,
    useProjectStore.getState().clips.length - before,
  );
  return showEditFeedback('split', changedCount);
}

export function splitClipWithFeedback(clipId: string): number {
  const before = useProjectStore.getState().clips.length;
  const state = useProjectStore.getState();
  state.splitClipAt(clipId, state.playhead);
  const changedCount = Math.max(
    0,
    useProjectStore.getState().clips.length - before,
  );
  return showEditFeedback('split', changedCount);
}

export function removeSelectedWithFeedback(): number {
  const before = useProjectStore.getState().clips.length;
  useProjectStore.getState().removeSelectedClips();
  const changedCount = Math.max(
    0,
    before - useProjectStore.getState().clips.length,
  );
  return showEditFeedback('delete', changedCount);
}

export function rippleDeleteSelectedWithFeedback(): number {
  const changedCount = useProjectStore.getState().rippleDeleteSelectedClips();
  return showEditFeedback('ripple-delete', changedCount);
}

export function removeClipWithFeedback(clipId: string): number {
  const before = useProjectStore.getState().clips.length;
  useProjectStore.getState().removeClip(clipId);
  const changedCount = Math.max(
    0,
    before - useProjectStore.getState().clips.length,
  );
  return showEditFeedback('delete', changedCount);
}

export function copySelectedWithFeedback(): number {
  const count = useProjectStore.getState().copySelectedClips();
  useProjectStore.getState().showMessage(
    count > 0 ? 'success' : 'info',
    count > 0
      ? `${count}本のクリップをコピーしました`
      : 'コピーするクリップを選択してください',
    2400,
  );
  return count;
}

export function pasteAtPlayheadWithFeedback(): number {
  const count = useProjectStore.getState().pasteClipsAtPlayhead();
  useProjectStore.getState().showMessage(
    count > 0 ? 'success' : 'info',
    count > 0
      ? `${count}本を再生位置へ貼り付けました（Ctrl+Zで元に戻せます）`
      : '貼り付けるクリップがないか、追加先トラックがロックされています',
    3200,
  );
  return count;
}

export function duplicateSelectedWithFeedback(): number {
  const count = useProjectStore.getState().duplicateSelectedClips();
  useProjectStore.getState().showMessage(
    count > 0 ? 'success' : 'info',
    count > 0
      ? `${count}本のクリップを複製しました（Ctrl+Zで元に戻せます）`
      : '複製するクリップを選択するか、トラックのロックを解除してください',
    3200,
  );
  return count;
}
