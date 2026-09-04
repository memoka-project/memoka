# Memoka

> [!WARNING]
> **Memokaは開発中のベータ版です。** 今後のreleaseでは、保存データ、設定、操作仕様を含む
> 互換性を壊す変更を行う可能性があります。重要なデータには必ず外部のバックアップと世代管理を
> 用意してください。

Memokaは、Vimの操作感でMarkdownを意識せず高速に書ける、ローカルファーストのメモ帳です。
ノートはTreeで整理し、各ノートの本文はSectionと構造化blockとして保存します。Markdownは
編集用の第二データではなく、選択したデータ領域へ自動生成される可搬mirrorです。

## 対応環境とインストール

v0.1.5の対応範囲はWindows 11 x64とUbuntu 24.04 / 26.04 x86_64です。deb、macOS、ARM、
Microsoft Store、apt repositoryは提供しません。

### Linux x86_64

公式binaryとして配布するのはLinux x86_64向けAppImageだけです。GitHub ReleasesからAppImageを
取得し、同じReleaseの`SHA256SUMS`でdownloadを検証してから実行権限を付けて起動します。
AppImageの更新artifactはTauri Updater用の鍵で署名します。

AppImageはホストdesktop sessionのWayland/X11、GTK input method、GIO、GStreamerを利用します。
Wayland / fcitx5では、環境によって日本語変換候補windowがcaretからずれて表示される既知制約があります。
入力欠落や二重確定とは分離して追跡しています。問題がある場合は、desktop session、display scale、
WebKitGTK、GLib、Mesa、fcitx5のversionを添えて報告してください。

### Windows 11 x64（source build）

Windowsはコード署名済みbinaryを配布せず、GitHub ReleaseのSource code archiveまたはrepositoryから
取得したsourceを利用環境上でbuildします。生成されるローカルbuildは公式署名・自動更新の対象外であり、
Windows SmartScreenの警告が表示される場合があります。

以下はWindows 11 x64と`winget`を前提とした手順です。MemokaのCIと同じNode.js 24 LTS、Rustの
MSVC toolchain、Tauri 2が必要とするMicrosoft C++ Build ToolsとWebView2 Runtimeを導入します。
詳細は[Tauri 2のWindows prerequisites](https://v2.tauri.app/start/prerequisites/)も参照してください。

#### 1. build依存環境をインストールする

PowerShellを開き、次を実行します。Build Toolsの導入時にはUACによる管理者権限の確認が表示されます。
`Microsoft.VisualStudio.Workload.VCTools`はTauriが必要とするC++ desktop workloadで、
`--includeRecommended`によりMSVC toolsetとWindows SDKも導入します。

```powershell
winget install --exact --id Git.Git --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
winget install --exact --id OpenJS.NodeJS.LTS --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
winget install --exact --id Rustlang.Rustup --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
winget install --exact --id Microsoft.EdgeWebView2Runtime --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity
winget install --exact --id Microsoft.VisualStudio.BuildTools --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity `
  --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Windows 11には通常WebView2 Runtimeが既に含まれます。その場合、上のWebView2コマンドはインストール済みと
表示されるだけです。すべてのインストールが終わったらPowerShellを閉じ、新しいPowerShellを開いてPATHを
読み直します。

#### 2. toolchainを初期化して確認する

```powershell
rustup default stable-msvc
rustup target add x86_64-pc-windows-msvc
corepack enable

git --version
node --version
corepack --version
rustc --version
cargo --version
```

`node --version`は`v24`系を想定しています。`rustc -Vv`の`host`が
`x86_64-pc-windows-msvc`であることも確認できます。

#### 3. sourceと依存packageを取得する

```powershell
git clone https://github.com/memoka-project/memoka.git
Set-Location memoka
corepack pnpm install --frozen-lockfile
```

Source code archiveを展開した場合は、`git clone`の代わりに展開先へ`Set-Location`してください。
`package.json`の`packageManager`指定により、Corepackはこのprojectで固定したpnpmを使用します。

#### 4. 検証・起動・buildを行う

CI相当の主要検証は次で実行します。

```powershell
corepack pnpm verify
```

開発版を起動する場合は次を実行します。初回はRust crateのcompileに時間がかかります。

```powershell
corepack pnpm tauri:dev
```

Windows用のrelease buildを作る場合は次を実行します。

```powershell
corepack pnpm tauri:build
```

`tauri:build`はWindowsではNSIS installerだけを生成します。主な出力先は次のとおりです。

- application本体: `target\release\memoka.exe`
- unsigned NSIS installer: `target\release\bundle\nsis\`

復旧CLIも必要な場合は`corepack pnpm cli:build`を実行します。出力は
`target\release\memoka-cli.exe`です。

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

ユーザー設定はapplication config directoryの`config.toml`から読み込みます。カラーテーマは
[Nightfox](https://github.com/EdenEast/nightfox.nvim)の7テーマから選べます。既定は`nightfox`です。
`:colorscheme`（`:colo`）はライブプレビュー付きの選択画面を開き、`:colorscheme duskfox`のように
直接指定することもできます。確定したテーマは次のトップレベル設定へ保存され、Workspaceを切り替えても
アプリケーション全体で共通です。

`:font`はプリセットまたは任意のCSS `font-family`をライブプレビューして選択します。通常のUIと本文へ
適用され、コード、行番号、Command-line、デバッグ情報は等幅フォントを維持します。Zoomは
`Ctrl+=` / `Ctrl++`、`Ctrl+-`、`Ctrl+0`で変更・リセットでき、`:zoom 120`のような直接指定もできます。
ノートの最大表示幅は`:note-width 1200`のようにCSS pxで指定できます。既定は`1000`で、
`:note-width off`または`0`で上限を解除します。フォント、Zoom、ノート幅はWorkspaceには依存しません。
行番号を省略するWindow幅は`:line-number-min-width 480`、Section、List、行番号境界から最初の
Section縦線までの間隔に共通するインデント幅は`:indent-width 24`のように指定します。日本語のword操作と表示上の改行方法も独立して
アプリケーション全体へ設定できます。

```toml
theme = "nightfox" # nightfox/dayfox/dawnfox/duskfox/nordfox/terafox/carbonfox
font_family = 'Noto Sans CJK JP, system-ui, sans-serif'
zoom_percent = 110 # 50〜200、10%刻み
note_max_width_px = 1000 # 320〜4096、0は上限なし
line_number_min_width_px = 480 # 240〜4096、0は狭いWindowでも常に表示
indent_width_px = 24 # 16〜64、SectionとListに共通の1階層の幅

[vim]
whichwrap = true # h/l/w/b/e/W/B/Eで前後の論理行へ移動

[japanese]
word_segmentation = "fine" # fine/budoux/unicode
line_break_segmentation = "fine" # fine/budoux/native

[shutdown]
wait_for_mirror = false
```

`whichwrap`は全blockで共通です。`false`にするとNormalの`h/l/w/b/e/W/B/E`とVisual Charの
`h/l/w/b/e`は現在の論理行端で停止します。Tableでは同じ論理行に属するCell間は引き続き
移動できますが、前後のTable行やTable外へは移動しません。既定値は`true`です。

`note_max_width_px`は行番号gutter、本文padding、すべてのblockを含むノートキャンバス全体の
最大幅です。Windowがそれより広いときは中央寄せになり、狭いときはWindow幅に追従します。
`:note-width`だけを実行すると現在値を表示します。表とコードブロックの水平スクロールは従来どおりです。

`line_number_min_width_px`より狭いEditor Windowでは行番号gutterを省略して本文領域を広げます。
`:line-number-min-width off`または`0`で幅による省略を無効にできます。`indent_width_px`はSectionの
1階層、Listのネスト、List marker、Table、Code Blockを同じ表示グリッドへ揃える設定です。List markerの
左端は行番号境界または所属Section縦線の次のグリッド線を基準に配置します。Bullet ListとNumbered Listの
本文位置は共通で、markerから本文までの間隔はインデント設定に連動しない固定の文字幅です。List全体の左方向への
微調整はインデント幅に比例し、32pxのとき0.5emです。ネストごとに1段ずつ進みます。
どちらのCommandも引数なしで現在値を表示します。

`:word-segmentation`は`w/b/e`、word operator、`iw/aw`、Insertの`Ctrl-w`で使う日本語境界を変更します。
`:line-break-segmentation`は本文と本文検索プレビューの表示上の改行候補だけを変更します。既定の`fine`は
BudouX文節を基礎に長い文節を最大10書記素程度へ細分化します。`budoux`は文節をそのまま使い、操作の
`unicode`は従来の文字種class、表示の`native`はブラウザ標準へ戻します。どちらのCommandも引数なしで
現在値を表示し、引数を指定すると即時反映して`config.toml`へ保存します。

終了時は既定で最新のMarkdown mirrorが確定するまで待ちます。正本のCRDT保存後すぐ終了し、mirrorを
次回起動後の自動生成へ回したい場合だけ、上記の`wait_for_mirror = false`を指定します。

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

組み込みカラーパレットはNightfox（MIT License、Copyright (c) 2021 James Simpson）に基づきます。
固定した上流commitとライセンス全文は[Third-party notices](THIRD_PARTY_NOTICES.md)に記載しています。
