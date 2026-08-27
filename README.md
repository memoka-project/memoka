# Memoka

Memokaは、Vimの操作感でMarkdownを意識せず高速に書ける、ローカルファーストのメモ帳です。
ノートはTreeで整理し、各ノートの本文はSectionと構造化blockとして保存します。Markdownは
編集用の第二データではなく、選択したデータ領域へ自動生成される可搬mirrorです。

## 対応環境とインストール

v0.1.0の対応範囲はWindows 11 x64とUbuntu 24.04 / 26.04 x86_64です。GitHub ReleasesからWindowsは
NSIS、LinuxはAppImageまたはdebを取得し、同じReleaseの`SHA256SUMS`でdownloadを検証してください。
AppImageは実行権限を付けて直接起動でき、debはOSのpackage managerでinstallします。macOS、ARM、
Microsoft Store、apt repositoryはまだ提供しません。

Wayland / fcitx5では、環境によって日本語変換候補windowがcaretからずれて表示される既知制約があります。
入力欠落や二重確定とは分離して追跡しています。問題が大きい場合は`GTK_IM_MODULE=fcitx`を設定して起動し、
display scale、WebKitGTK、fcitx5のversionを添えて報告してください。

## 開発

必要な環境はNode.js、Corepack、Rust、Tauri 2のLinuxまたはWindows向け依存パッケージです。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

主要な検証は次で実行します。

```bash
corepack pnpm verify
corepack pnpm large-note-gate
corepack pnpm tauri:build
```

製品コード、テスト、配布Workflowはこのrepositoryだけで完結します。内部仕様、ADR、計画、検証記録、
release運用文書は公開source treeとは分離して管理しています。

## データと復旧

初回起動時にWorkspaceデータ領域を選択します。内部SSOTはその直下の`.memoka/`に保存され、
人間可読なMarkdown mirrorはデータ領域直下へ自動出力されます。復旧前には同梱のCLIで検証します。

```bash
memoka-cli verify --source <portable-mirror-data-area>
memoka-cli restore --source <portable-mirror-data-area> --target <empty-data-area>
```

## ライセンス

[MIT License](LICENSE)
