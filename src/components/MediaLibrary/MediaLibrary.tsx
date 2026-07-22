import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { AlertTriangle, Link2, Music, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useMediaStore } from '../../stores/mediaStore';
import { clearHistory, useProjectStore } from '../../stores/projectStore';
import { formatDuration, formatFileSize } from '../../lib/media';
import type { MediaAsset } from '../../lib/types';
import {
  assetRelinkError,
  requiredAssetSourceDuration,
  type ProjectAssetRef,
} from '../../lib/project';
import { ConfirmDialog } from '../Common/ConfirmDialog';
import styles from './MediaLibrary.module.css';

interface MediaLibraryProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function selectionErrorMessage(errors: string[]): string {
  if (errors.length === 0) return '選択したファイルを追加できませんでした';
  const visible = errors.slice(0, 3).join(' / ');
  return errors.length > 3 ? `${visible} / ほか${errors.length - 3}件` : visible;
}

export function MediaLibrary({ collapsed, onToggleCollapse }: MediaLibraryProps) {
  const assets = useMediaStore((s) => s.assets);
  const selectedAssetId = useMediaStore((s) => s.selectedAssetId);
  const isImporting = useMediaStore((s) => s.isImporting);
  const importStatus = useMediaStore((s) => s.importStatus);
  const importError = useMediaStore((s) => s.importError);
  const addFiles = useMediaStore((s) => s.addFiles);
  const addNativeSources = useMediaStore((s) => s.addNativeSources);
  const selectAsset = useMediaStore((s) => s.selectAsset);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const clearError = useMediaStore((s) => s.clearError);
  const showMessage = useProjectStore((s) => s.showMessage);
  const expectedAssets = useProjectStore((s) => s.expectedAssets);
  const remapAssetIds = useProjectStore((s) => s.remapAssetIds);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const [relinkTarget, setRelinkTarget] = useState<ProjectAssetRef | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPickingMedia, setIsPickingMedia] = useState(false);
  // Track nested dragenter events so dragleave on a child doesn't flip the
  // overlay off while still hovering the parent drop zone.
  const dragDepthRef = useRef(0);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (isImporting) {
      showMessage('info', '現在の読み込みが終わるまでお待ちください', 2500);
      return;
    }
    const count = files.length;
    void addFiles(files).then((created) => {
      if (created.length === count) {
        showMessage('success', `${created.length}個のファイルを追加しました`, 1800);
      } else if (created.length > 0) {
        showMessage(
          'info',
          `${created.length}個を追加、${count - created.length}個は読み込めませんでした`,
          4000,
        );
      } else {
        showMessage(
          'error',
          useMediaStore.getState().importError ??
            'ファイルを追加できませんでした。対応形式または読み取り権限を確認してください',
          6000,
        );
      }
    });
  };

  const handleClick = () => {
    if (isImporting || isPickingMedia) {
      showMessage(
        'info',
        isPickingMedia
          ? 'ファイル選択画面を操作してください'
          : '現在の読み込みが終わるまでお待ちください',
        2500,
      );
      return;
    }
    const selectMediaFiles = window.fce?.selectMediaFiles;
    if (!selectMediaFiles) {
      fileInputRef.current?.click();
      return;
    }
    setIsPickingMedia(true);
    void selectMediaFiles({ multiple: true })
      .then(async ({ sources, errors, canceled }) => {
        if (canceled) return;
        if (sources.length === 0) {
          showMessage('error', selectionErrorMessage(errors), 6000);
          return;
        }
        const created = await addNativeSources(sources);
        if (created.length === sources.length) {
          showMessage(
            errors.length > 0 ? 'info' : 'success',
            errors.length > 0
              ? `${created.length}個を追加しました / ${selectionErrorMessage(errors)}`
              : `${created.length}個のファイルを追加しました`,
            errors.length > 0 ? 6000 : 1800,
          );
        } else if (created.length > 0) {
          showMessage(
            'info',
            `${created.length}個を追加、${sources.length - created.length}個は読み込めませんでした`,
            4000,
          );
        } else {
          showMessage(
            'error',
            useMediaStore.getState().importError ?? selectionErrorMessage(errors),
            6000,
          );
        }
      })
      .catch(() => {
        showMessage('error', 'ファイル選択を開けませんでした', 4000);
      })
      .finally(() => {
        setIsPickingMedia(false);
      });
  };
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
    e.target.value = '';
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  };
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    // dataTransfer.dropEffect feedback helps the cursor show "copy"
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (!isDragging) setIsDragging(true);
  };
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const finishRelink = (
    asset: MediaAsset,
    target: ProjectAssetRef,
    sourceName: string,
  ) => {
    const project = useProjectStore.getState();
    const requiredDuration = requiredAssetSourceDuration(
      target.id,
      project.clips,
      project.markers,
      project.ioRanges,
    );
    const error = assetRelinkError(target, asset, requiredDuration);
    if (error) {
      removeAsset(asset.id);
      showMessage('error', error, 6000);
      return;
    }
    remapAssetIds({ [target.id]: asset.id });
    showMessage('success', `「${target.name}」を「${sourceName}」へ再リンクしました`, 4000);
  };

  const chooseRelinkFile = (ref: ProjectAssetRef) => {
    if (isImporting || isPickingMedia) {
      showMessage(
        'info',
        isPickingMedia
          ? 'ファイル選択画面を操作してください'
          : '現在の読み込みが終わるまでお待ちください',
        2500,
      );
      return;
    }
    const selectMediaFiles = window.fce?.selectMediaFiles;
    if (selectMediaFiles) {
      setIsPickingMedia(true);
      void selectMediaFiles({ kind: ref.kind, multiple: false })
        .then(async ({ sources, errors, canceled }) => {
          if (canceled) return;
          if (sources.length === 0) {
            showMessage('error', selectionErrorMessage(errors), 6000);
            return;
          }
          const created = await addNativeSources(sources);
          const asset = created[0];
          if (!asset) {
            showMessage('error', '選択したファイルを読み込めませんでした', 4000);
            return;
          }
          finishRelink(asset, ref, sources[0].name);
        })
        .catch(() => {
          showMessage('error', 'ファイル選択を開けませんでした', 4000);
        })
        .finally(() => {
          setIsPickingMedia(false);
        });
      return;
    }
    setRelinkTarget(ref);
    window.setTimeout(() => relinkInputRef.current?.click(), 0);
  };

  const handleRelinkChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const target = relinkTarget;
    setRelinkTarget(null);
    if (!file || !target) return;
    const created = await addFiles([file]);
    const asset = created[0];
    if (!asset) {
      showMessage('error', '選択したファイルを読み込めませんでした', 4000);
      return;
    }
    finishRelink(asset, target, file.name);
  };

  const videoAssets = assets.filter((a) => a.kind === 'video');
  const audioAssets = assets.filter((a) => a.kind === 'audio');

  if (collapsed) {
    return (
      <div className={styles.rootCollapsed}>
        <button
          type="button"
          className={styles.collapseToggle}
          onClick={onToggleCollapse}
          aria-label="メディアライブラリを開く"
          title="メディアライブラリを開く"
        >
          <PanelLeftOpen size={16} aria-hidden="true" />
        </button>
        {assets.length > 0 ? <span className={styles.countCollapsed}>{assets.length}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>メディアライブラリ</span>
        <div className={styles.headerRight}>
          <span className={styles.count}>{assets.length}</span>
          <button
            type="button"
            className={styles.collapseToggle}
            onClick={onToggleCollapse}
            aria-label="メディアライブラリを閉じる"
            title="メディアライブラリを閉じる"
          >
            <PanelLeftClose size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="動画または音声ファイルを追加"
        aria-dropeffect="copy"
        aria-disabled={isImporting}
      >
        <div
          className={`${styles.dropZoneIcon} ${isDragging ? styles.dropZoneIconActive : ''}`}
          aria-hidden="true"
        >
          <Plus size={26} strokeWidth={2} />
        </div>
        <div className={styles.dropZoneTextStrong}>
          {isImporting
            ? (importStatus ?? '読み込み中…')
            : isDragging
              ? 'ここにドロップ'
              : 'ファイルを追加'}
        </div>
        <div className={styles.dropZoneTextDim}>クリック / ドラッグ&ドロップ</div>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          onChange={handleChange}
          aria-label="動画または音声ファイルを選択"
          className={styles.fileInput}
        />
      </div>

      {importError && (
        <button
          type="button"
          className={styles.error}
          onClick={clearError}
          aria-label="読み込みエラーを閉じる"
        >
          {importError}
          <span className={styles.errorClose} aria-hidden="true">×</span>
        </button>
      )}

      {expectedAssets.length > 0 ? (
        <section className={styles.missingSection} aria-labelledby="missing-media-title">
          <div className={styles.missingHeader}>
            <AlertTriangle size={14} aria-hidden="true" />
            <span id="missing-media-title">見つからない素材（{expectedAssets.length}）</span>
          </div>
          <p className={styles.missingHelp}>移動・改名した元ファイルを選び直してください。</p>
          {expectedAssets.map((ref) => (
            <div key={ref.id} className={styles.missingItem}>
              <span className={styles.missingName} title={ref.path ?? ref.name}>
                {ref.name}
              </span>
              <button
                type="button"
                className={styles.relinkBtn}
                onClick={() => chooseRelinkFile(ref)}
                disabled={isImporting}
                aria-label={`${ref.name}を再リンク`}
              >
                <Link2 size={13} aria-hidden="true" />
                選び直す
              </button>
            </div>
          ))}
          <input
            ref={relinkInputRef}
            type="file"
            accept={relinkTarget?.kind === 'audio' ? 'audio/*' : 'video/*'}
            onChange={(event) => void handleRelinkChange(event)}
            className={styles.fileInput}
            aria-label="再リンクする元ファイルを選択"
          />
        </section>
      ) : null}

      <div className={styles.list}>
        {assets.length === 0 ? (
          <div className={styles.empty}>
            <p>まだメディアがありません</p>
            <p className={styles.emptyDim}>動画または音声ファイルを追加してみましょう</p>
          </div>
        ) : (
          <>
            {videoAssets.length > 0 && (
              <MediaSection
                label="動画"
                assets={videoAssets}
                selectedId={selectedAssetId}
                onSelect={selectAsset}
                onRemove={removeAsset}
              />
            )}
            {audioAssets.length > 0 && (
              <MediaSection
                label="音声"
                assets={audioAssets}
                selectedId={selectedAssetId}
                onSelect={selectAsset}
                onRemove={removeAsset}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface MediaSectionProps {
  label: string;
  assets: MediaAsset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function MediaSection({ label, assets, selectedId, onSelect, onRemove }: MediaSectionProps) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{label}</div>
      {assets.map((asset) => (
        <MediaItem
          key={asset.id}
          asset={asset}
          isSelected={asset.id === selectedId}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

interface MediaItemProps {
  asset: MediaAsset;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function MediaItem({ asset, isSelected, onSelect, onRemove }: MediaItemProps) {
  const addClipFromAsset = useProjectStore((s) => s.addClipFromAsset);
  const clips = useProjectStore((s) => s.clips);
  const markers = useProjectStore((s) => s.markers);
  const ioRanges = useProjectStore((s) => s.ioRanges);
  const removeAssetReferences = useProjectStore((s) => s.removeAssetReferences);
  const tracks = useProjectStore((s) => s.tracks);
  const [pendingDelete, setPendingDelete] = useState<{
    clipCount: number;
    markerCount: number;
    rangeCount: number;
  } | null>(null);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    const clipCount = clips.filter((clip) => clip.assetId === asset.id).length;
    const markerCount = markers.filter((marker) => marker.assetId === asset.id).length;
    const rangeCount = ioRanges.filter((range) => range.assetId === asset.id).length;
    setPendingDelete({ clipCount, markerCount, rangeCount });
  };

  const confirmRemove = () => {
    if (!pendingDelete) return;
    const hadUndoHistory =
      useProjectStore.temporal.getState().pastStates.length > 0;
    removeAssetReferences(asset.id);
    onRemove(asset.id);
    // Media resources live outside zundo. Clearing the document history keeps
    // Ctrl+Z from resurrecting a clip whose source Blob/token was released.
    clearHistory();
    useProjectStore
      .getState()
      .showMessage(
        'info',
        hadUndoHistory ||
          pendingDelete.clipCount +
            pendingDelete.markerCount +
            pendingDelete.rangeCount >
            0
          ? '素材と関連項目を削除しました（編集履歴をクリア）'
          : '素材を削除しました',
        3500,
      );
    setPendingDelete(null);
  };

  const handleAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    const compatibleTracks = tracks.filter((track) =>
      asset.kind === 'audio'
        ? track.kind === 'audio'
        : track.kind === 'video' || track.kind === 'overlay',
    );
    const track =
      compatibleTracks.find((candidate) => !candidate.locked) ??
      compatibleTracks[0];
    if (!track) {
      useProjectStore
        .getState()
        .showMessage('error', '追加先のトラックが見つかりません');
      return;
    }
    if (track.locked) {
      useProjectStore
        .getState()
        .showMessage(
          'info',
          `「${track.label}」のロックを解除してから追加してください`,
          3000,
        );
      return;
    }
    const clipId = addClipFromAsset(asset.id, track.id, asset.duration);
    if (clipId) onSelect(asset.id);
    useProjectStore
      .getState()
      .showMessage(
        clipId ? 'success' : 'error',
        clipId
          ? `「${asset.name}」を${track.label}の末尾へ追加しました（Ctrl+Zで元に戻せます）`
          : 'タイムラインへ追加できませんでした',
        3200,
      );
  };

  return (
    <>
      <div
        className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}
        role="group"
        aria-label={`${asset.name} の操作`}
        data-media-asset-id={asset.id}
      >
      <button
        type="button"
        className={styles.itemSelect}
        onClick={() => onSelect(asset.id)}
        aria-pressed={isSelected}
      >
        <LazyThumbnail asset={asset} />
        <div className={styles.itemMeta}>
          <div className={styles.itemName} title={asset.name}>
            {asset.name}
          </div>
          <div className={styles.itemSub}>
            <span>{formatDuration(asset.duration)}</span>
            <span>·</span>
            <span>{formatFileSize(asset.size)}</span>
            {asset.previewProxy ? <span className={styles.proxyBadge}>互換プレビュー</span> : null}
          </div>
        </div>
      </button>
      <div className={styles.itemActions}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={handleAdd}
          aria-label={`${asset.name}をタイムラインに追加`}
          title="タイムラインに追加"
        >
          <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.removeBtn}
          onClick={handleRemove}
          aria-label={`${asset.name}を素材一覧から削除`}
          title="削除"
        >
          ×
        </button>
      </div>
      </div>
      {pendingDelete ? (
        <ConfirmDialog
          title="素材を削除"
          message={
            `「${asset.name}」を素材一覧から削除します。` +
            (pendingDelete.clipCount +
              pendingDelete.markerCount +
              pendingDelete.rangeCount >
            0
              ? ` 関連するクリップ${pendingDelete.clipCount}件、マーカー${pendingDelete.markerCount}件、範囲${pendingDelete.rangeCount}件も削除します。`
              : '') +
            ' この操作は取り消せず、参照切れを防ぐため編集履歴もクリアされます。'
          }
          confirmLabel="素材を削除"
          variant="destructive"
          onConfirm={confirmRemove}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}

function LazyThumbnail({ asset }: { asset: MediaAsset }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || asset.kind !== 'video') return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '100px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [asset.kind]);

  return (
    <div ref={ref} className={styles.thumbnail} data-kind={asset.kind}>
      {asset.kind === 'video' ? (
        visible ? (
          <video
            src={asset.url}
            crossOrigin="anonymous"
            muted
            preload="metadata"
            className={styles.thumbVideo}
          />
        ) : null
      ) : (
        <div className={styles.thumbAudio}>
          <Music size={22} strokeWidth={1.8} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
