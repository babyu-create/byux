import { useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { Plus, Music } from 'lucide-react';
import { useMediaStore } from '../../stores/mediaStore';
import { useProjectStore } from '../../stores/projectStore';
import { formatDuration, formatFileSize } from '../../lib/media';
import type { MediaAsset } from '../../lib/types';
import styles from './MediaLibrary.module.css';

export function MediaLibrary() {
  const assets = useMediaStore((s) => s.assets);
  const selectedAssetId = useMediaStore((s) => s.selectedAssetId);
  const isImporting = useMediaStore((s) => s.isImporting);
  const importError = useMediaStore((s) => s.importError);
  const addFiles = useMediaStore((s) => s.addFiles);
  const selectAsset = useMediaStore((s) => s.selectAsset);
  const removeAsset = useMediaStore((s) => s.removeAsset);
  const clearError = useMediaStore((s) => s.clearError);
  const showMessage = useProjectStore((s) => s.showMessage);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Track nested dragenter events so dragleave on a child doesn't flip the
  // overlay off while still hovering the parent drop zone.
  const dragDepthRef = useRef(0);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const count = files.length;
    void addFiles(files).then(() => {
      // Show a brief acknowledgment so users know their drop registered
      // even when the import list scrolls or the new items render below the fold.
      showMessage('success', `${count}個のファイルを追加しました`, 1800);
    });
  };

  const handleClick = () => fileInputRef.current?.click();
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

  const videoAssets = assets.filter((a) => a.kind === 'video');
  const audioAssets = assets.filter((a) => a.kind === 'audio');

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>メディアライブラリ</span>
        <span className={styles.count}>{assets.length}</span>
      </div>

      <div
        className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={0}
        aria-label="動画ファイルをアップロード"
        aria-dropeffect="copy"
      >
        <div
          className={`${styles.dropZoneIcon} ${isDragging ? styles.dropZoneIconActive : ''}`}
          aria-hidden="true"
        >
          <Plus size={26} strokeWidth={2} />
        </div>
        <div className={styles.dropZoneTextStrong}>
          {isImporting
            ? '読み込み中…'
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
          className={styles.fileInput}
        />
      </div>

      {importError && (
        <div className={styles.error} onClick={clearError} role="alert">
          {importError}
          <span className={styles.errorClose}>×</span>
        </div>
      )}

      <div className={styles.list}>
        {assets.length === 0 ? (
          <div className={styles.empty}>
            <p>まだメディアがありません</p>
            <p className={styles.emptyDim}>VALORANTの録画 (.mp4) を追加してみましょう</p>
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
  const tracks = useProjectStore((s) => s.tracks);

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove(asset.id);
  };

  const handleAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    const targetKind = asset.kind === 'audio' ? 'audio' : 'video';
    const track = tracks.find((t) => t.kind === targetKind);
    if (!track) return;
    addClipFromAsset(asset.id, track.id, asset.duration);
  };

  return (
    <div
      className={`${styles.item} ${isSelected ? styles.itemSelected : ''}`}
      onClick={() => onSelect(asset.id)}
      role="button"
      tabIndex={0}
    >
      <div className={styles.thumbnail} data-kind={asset.kind}>
        {asset.kind === 'video' ? (
          <video src={asset.url} muted preload="metadata" className={styles.thumbVideo} />
        ) : (
          <div className={styles.thumbAudio}><Music size={22} strokeWidth={1.8} aria-hidden="true" /></div>
        )}
      </div>
      <div className={styles.itemMeta}>
        <div className={styles.itemName} title={asset.name}>
          {asset.name}
        </div>
        <div className={styles.itemSub}>
          <span>{formatDuration(asset.duration)}</span>
          <span>·</span>
          <span>{formatFileSize(asset.file.size)}</span>
        </div>
      </div>
      <div className={styles.itemActions}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={handleAdd}
          aria-label="タイムラインに追加"
          title="タイムラインに追加"
        >
          <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.removeBtn}
          onClick={handleRemove}
          aria-label="削除"
          title="削除"
        >
          ×
        </button>
      </div>
    </div>
  );
}
