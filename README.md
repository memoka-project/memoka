# Memoka

Memokaは、Vimの操作感でMarkdownを意識せず高速に書ける、ローカルファーストのメモ帳です。
ノートはTreeで整理し、各ノートの本文はSectionと構造化blockとして保存します。Markdownは
編集用の第二データではなく、選択したデータ領域へ自動生成される可搬mirrorです。

## 対応環境とインストール

v0.1.1の対応範囲はWindows 11 x64とUbuntu 24.04 / 26.04 x86_64です。公式binaryとして配布するのは
Linux x86_64向けAppImageだけです。GitHub ReleasesからAppImageを取得し、同じReleaseの
`SHA256SUMS`でdownloadを検証してから実行権限を付けて起動します。AppImageの更新artifactは
Tauri Updater用の鍵で署名します。deb、macOS、ARM、Microsoft Store、apt repositoryは提供しません。

Windowsはコード署名済みbinaryを配布せず、GitHub ReleaseのSource code archiveまたはrepositoryから
取得したsourceを利用環境上でbuildします。Node.js、Corepack、Rust、Tauri 2のWindows向け依存環境を
用意したPowerShellで次を実行してください。生成されるローカルbuildは公式署名・自動更新の対象外です。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
corepack pnpm tauri:build
```

AppImageはホストdesktop sessionのWayland/X11、GTK input method、GIO、GStreamerを利用します。
Wayland / fcitx5では、環境によって日本語変換候補windowがcaretからずれて表示される既知制約があります。
入力欠落や二重確定とは分離して追跡しています。問題がある場合は、desktop session、display scale、
WebKitGTK、GLib、Mesa、fcitx5のversionを添えて報告してください。

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

ユーザー設定はapplication config directoryの`config.toml`から読み込みます。終了時は既定で最新の
Markdown mirrorが確定するまで待ちます。正本のCRDT保存後すぐ終了し、mirrorを次回起動後の自動生成へ
回したい場合は次を設定します。

```toml
[shutdown]
wait_for_mirror = false
```

製品コード、テスト、配布Workflowはこのrepositoryだけで完結します。内部仕様、ADR、計画、検証記録、
release運用文書は公開source treeとは分離して管理しています。

## データと復旧

初回起動時にWorkspaceデータ領域を選択します。内部SSOTはその直下の`.memoka/`に保存され、
人間可読なMarkdown mirrorはデータ領域直下へ自動出力されます。起動時はmanifestと正本のrevisionを
照合し、一致していれば再生成しません。通常の本文編集では変更Noteだけを更新し、タイトル由来pathが
変わる操作やmirror破損時にはリンク整合性を保つため全体を再構築します。復旧前には同梱のCLIで検証します。
通常起動できるMemokaは1プロセスだけです。二重起動した場合、新しいプロセスはWorkspaceを開かず終了し、
既存Windowを復元して前面へ移動します。

```bash
memoka-cli verify --source <portable-mirror-data-area>
memoka-cli restore --source <portable-mirror-data-area> --target <empty-data-area>
```

## ライセンス

[MIT License](LICENSE)
