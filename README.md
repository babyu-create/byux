# Byux

FPSキル集編集に特化したシンプルな動画エディタ。VALORANT / Apex / CS2 など、ゲームの録画から「キル集」を最短ルートで作るためのツール。

## 主な機能

- 🎯 **キルマーカー**: `K` キー連打でキル位置を記録 → ボタン1発で N 本のキルクリップに自動分割
- ✂ **I/O レンジカット**: `I` → `O` で範囲を指定 → 一括カット
- 🎵 **BGM + ビート検出**: 音楽の拍を自動検出、クリップ端をビートに吸着
- ⚡ **エフェクト**: フェードイン/フェードアウト、再生速度 (¼× 〜 2×)
- 🎬 **テキストオーバーレイ**: クリップにテキストを重ねる
- 📦 **MP4 書き出し**: FFmpeg.wasm によるブラウザ内エンコード (1080p / 60fps)
- 💾 **プロジェクト保存/ロード**: JSON で進捗を保持
- ⌨ **カスタムショートカット**: 全キーバインド変更可能

## ダウンロード

[最新リリース](../../releases/latest) からインストーラを取得してください。

- Windows: `Byux-Setup-X.Y.Z.exe` (インストーラ) または `Byux-Portable-X.Y.Z.exe` (ポータブル)
- Linux: `Byux-X.Y.Z.tar.gz` (展開して実行)
- macOS: 準備中

## クイックスタート

1. アプリ起動
2. VALORANT等の試合録画 (.mp4) をドラッグ&ドロップ
3. 「+」ボタンでタイムラインに追加
4. 動画再生中、キルの瞬間に **K キー**
5. プロパティパネルの **「マーカーから自動切り出し」** をクリック
6. **「📦 書き出し」** で MP4 出力

## 開発

```bash
# Web 版を開発モードで起動
npm install
npm run dev

# Electron 版で開発
npm run electron:dev

# 本番ビルド
npm run package:win        # Windows .exe
npm run package:linux      # Linux .tar.gz
npm run package:mac        # macOS .dmg (要 macOS)
```

## 技術スタック

- React 19 + TypeScript + Vite
- Zustand (状態管理)
- @dnd-kit (ドラッグ操作)
- FFmpeg.wasm (動画書き出し)
- Electron + electron-builder (デスクトップ化)
- electron-updater (自動アップデート)

## ライセンス

MIT License — 詳しくは [LICENSE](./LICENSE) を参照。
