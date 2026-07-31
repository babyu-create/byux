# 公開ビルドのコード署名

`npm run package:win` はローカル QA 用なので、証明書なしでも実行できます。公開用の `release:win` / `release:mac` / `release` は、誤って署名なしの実行ファイルを配布しないよう、ビルド前後に署名ゲートを通ります。

## Windows

electron-builder が参照する CI secret を設定します。

- `CSC_LINK`: `.p12` / `.pfx` の絶対パス、または Base64 化した証明書
- `CSC_KEY_PASSWORD`: 証明書のパスワード

`WIN_CSC_LINK` と `WIN_CSC_KEY_PASSWORD` も利用できます。値そのものはログに出さないでください。

公開前に次を実行します。

```powershell
node scripts/verify-release-signing.cjs preflight win
npm run release:win
```

ビルド後は `Byux-Setup-<version>.exe`、`Byux-Portable-<version>.exe`、`win-unpacked/Byux.exe` の Authenticode 状態が `Valid` でなければ公開を中止します。

## macOS

署名証明書に加えて、次のどちらかの notarization 情報を CI secret に登録します。

- `CSC_LINK`（または `CSC_NAME`）と `CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- `CSC_LINK`（または `CSC_NAME`）と `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`

```bash
node scripts/verify-release-signing.cjs preflight mac
npm run release:mac
```

## 失敗した場合

`RELEASE_SIGNING_FAILED` が出た公開処理は GitHub Release を作成しません。証明書の期限・秘密情報名・CI secret の登録先を確認し、`npm run package:win` で動作確認用パッケージだけを作成してください。
