import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHistory,
  captureProjectSavedBaseline,
  isProjectDirty,
  markProjectSaved,
  markProjectUnsaved,
  useProjectStore,
} from './projectStore';
import { useMediaStore } from './mediaStore';
import type { MediaAsset } from '../lib/types';

describe('project dirty tracking', () => {
  beforeEach(() => {
    useMediaStore.setState({ assets: [], selectedAssetId: null });
    useProjectStore.setState({ name: 'baseline' });
    clearHistory();
    markProjectSaved();
  });

  it('becomes dirty immediately without waiting for temporal debounce', () => {
    useProjectStore.setState({ name: 'edited' });
    expect(isProjectDirty()).toBe(true);
  });

  it('compares document identity instead of history depth', () => {
    useProjectStore.setState({ name: 'saved-state' });
    markProjectSaved();

    useProjectStore.setState({ name: 'branch-a' });
    expect(isProjectDirty()).toBe(true);

    useProjectStore.setState({ name: 'branch-b' });
    expect(isProjectDirty()).toBe(true);

    useProjectStore.setState({ name: 'saved-state' });
    expect(isProjectDirty()).toBe(false);
  });

  it('tracks saved media changes but ignores derived waveform data', () => {
    const asset: MediaAsset = {
      id: 'asset-1',
      name: 'clip.mp4',
      kind: 'video',
      url: 'blob:test',
      size: 123,
      mimeType: 'video/mp4',
      duration: 5,
    };
    useMediaStore.setState({ assets: [asset] });
    expect(isProjectDirty()).toBe(true);

    markProjectSaved();
    useMediaStore.setState({
      assets: [
        {
          ...asset,
          waveform: { peaks: new Float32Array([0.5]), peaksPerSecond: 10 },
        },
      ],
    });
    expect(isProjectDirty()).toBe(false);

    useMediaStore.setState({ assets: [] });
    expect(isProjectDirty()).toBe(true);
  });

  it('keeps edits made while an async save is in flight dirty', () => {
    useProjectStore.setState({ name: 'sent-to-disk' });
    const baseline = captureProjectSavedBaseline();

    useProjectStore.setState({ name: 'edited-during-save' });
    markProjectSaved(baseline);

    expect(isProjectDirty()).toBe(true);
    expect(useProjectStore.getState().savedDocument?.name).toBe('sent-to-disk');
  });

  it('can force a recovered or fail-safe document to require explicit save', () => {
    expect(isProjectDirty()).toBe(false);
    markProjectUnsaved();
    expect(isProjectDirty()).toBe(true);
  });
});
