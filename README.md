# Memoka

> [!WARNING]
> **Memokaは開発中のベータ版です。** 今後のreleaseでは、保存データ、設定、操作仕様を含む
> 互換性を壊す変更を行う可能性があります。重要なデータには必ず外部のバックアップと世代管理を
> 用意してください。

Memokaは、Vimが手に馴染んでしまいメモ帳では満足できず、Markdownを手で書きたくないVimmerのためのノートアプリです。

- Vimの操作感でMarkdown記法を意識せずにノートを書けます。
- ノートをツリー構造で整理できます。
- Markdownを出力します。

## 対応環境とインストール

v0.1.8の対応範囲はWindows 11 x64とUbuntu 24.04 / 26.04 x86_64です。deb、macOS、ARM、
Microsoft Store、apt repositoryは提供しません。

### Linux x86_64

公式binaryとして配布するのはLinux x86_64向けAppImageだけです。GitHub ReleasesからAppImageを
取得し、同じReleaseの`SHA256SUMS`でdownloadを検証してから実行権限を付けて起動します。
AppImageの更新artifactはTauri Updater用の鍵で署名します。

```bash
sha256sum --check SHA256SUMS --ignore-missing
chmod +x Memoka_*_amd64.AppImage
./Memoka_*_amd64.AppImage
```

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

## 設定ファイル

ユーザー設定は、TauriがOSごとに解決するapplication config directoryの`config.toml`から読み込みます。
ファイルがない場合は既定値で起動し、起動するだけではファイルを作成しません。設定commandを確定すると
必要な項目が保存されます。ファイルを直接編集した場合はMemokaを再起動してください。

```toml
theme = "nightfox" # nightfox/dayfox/dawnfox/duskfox/nordfox/terafox/carbonfox
font_family = 'Noto Sans CJK JP, system-ui, sans-serif'
zoom_percent = 110 # 50〜200、10%刻み
note_max_width_px = 1000 # 320〜4096、0は上限なし
line_number_min_width_px = 480 # 240〜4096、0は常に行番号を表示
indent_width_px = 24 # 16〜64
leader = ","

[vim]
whichwrap = true

[japanese]
word_segmentation = "fine" # fine/budoux/unicode
line_break_segmentation = "fine" # fine/budoux/native

[shutdown]
wait_for_mirror = true

[keymap.shared_navigation]
"cursor.logical-up" = ["k"]
"cursor.logical-down" = ["j"]

[keymap.tree_normal]
"note.create_child" = ["c"]

[keymap.visual_char]
"selection.format" = ["m"]

[keymap.table]
"table.next_cell" = ["Tab"]
"table.previous_cell" = ["Shift+Tab"]
"mode.visual-block" = ["Ctrl+v"]
```

主な設定commandは次のとおりです。引数を省略すると現在値または選択画面を表示します。

| Command                                           | 設定内容                 |
| ------------------------------------------------- | ------------------------ |
| `:colorscheme [name]` / `:colo`                   | カラーテーマ             |
| `:font`                                           | UIと本文のフォント       |
| `:zoom [50..200]`                                 | アプリケーションの拡大率 |
| `:note-width [px/off]`                            | ノートの最大表示幅       |
| `:line-number-min-width [px/off]`                 | 行番号を表示する最小幅   |
| `:indent-width [16..64]`                          | 共通インデント幅         |
| `:word-segmentation [mode]` / `:word-segment`     | 日本語の単語分割         |
| `:line-break-segmentation [mode]` / `:line-break` | 日本語の表示上の改行     |

カラーテーマには[Nightfox](https://github.com/EdenEast/nightfox.nvim)の7テーマを収録しています。

## CLI

`memoka-cli`は、Memokaがデータ領域へ出力したportable mirrorの検証と、空のデータ領域への復旧に使用します。
復旧時はMemokaを終了し、復旧元と復旧先に別のディレクトリを指定してください。

```bash
memoka-cli verify --source <portable-mirror-data-area>
memoka-cli restore --source <portable-mirror-data-area> --target <empty-data-area>
```

CLIをsourceからbuildするには、repository rootで次を実行します。

```bash
corepack pnpm cli:build
```

出力先はLinuxでは`target/release/memoka-cli`、Windowsでは`target\release\memoka-cli.exe`です。

## 開発

必要な環境はNode.js 24 LTS、Corepack、Rust stable、Tauri 2のLinuxまたはWindows向け依存packageです。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

主要な検証とbuildは次で実行します。

```bash
corepack pnpm verify
corepack pnpm large-note-gate
corepack pnpm tauri:build
```

## ライセンス

[MIT License](LICENSE)

組み込みカラーパレットはNightfox（MIT License、Copyright (c) 2021 James Simpson）に基づきます。
固定した上流commitとライセンス全文は[Third-party notices](THIRD_PARTY_NOTICES.md)に記載しています。
