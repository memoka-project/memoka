# Platform、配布、Security

[仕様書へ戻る](../specification.md)

## 1. 対応範囲

現行の検証対象は次である。

- Ubuntu 24.04 / 26.04 x86_64
- Windows 11 x64

macOS、ARM、Microsoft Store、apt repository、deb repository、自前CDNは対象外である。

## 2. Linux配布

公式binaryとしてGitHub Releasesで配布するのはLinux x86_64 AppImageだけである。

Releaseには少なくとも次を含める。

- AppImage
- Tauri Updater signature
- `latest.json`
- standalone `memoka-cli` archive
- `SHA256SUMS`
- SPDX JSON SBOM
- Source code archive

AppImageはhostのWayland/X11、GTK/WebKitGTK、GLib/GIO、GStreamer、Mesa、input method環境を利用する。
AppImage内の同名system moduleを誤って優先し、host GVFS/EGLを壊さないようruntime environmentを構成する。

GNOMEとSway/fcitx5で起動、IME、Clipboard、終了を確認する。Waylandでは変換候補windowのcaret位置ずれを
platform制約として追跡するが、composition text非表示、欠落、重複はrelease blockerである。

## 3. Windows配布

Windows向けの公式署名済みbinary、installer、Updater artifactは公開しない。
GitHubのSource code archiveまたはrepositoryをWindows 11 x64上でbuildして利用する。

local buildはMSVC toolchain、Windows SDK、WebView2 Runtime、Node.js/Corepackを使用する。
`corepack pnpm tauri:build`はunsigned NSIS installerを生成できるが、公式配布物ではない。
standalone復旧CLIもlocal buildできる。

Windows ClipboardはCF_UNICODETEXT、CF_HDROP、登録PNG、CF_DIBV5/CF_DIBなどのnative adapterを使用する。
Microsoft IMEとWebView2で入力確定の欠落・二重反映がないことを確認する。

## 4. 開発branchとCI

開発中の変更は`develop`へpushし、動作確認後に`main`へ反映する。
通常CIはpull requestと`main`へのpushで実行する。

CIはLinuxとWindowsでformat、lint、typecheck、unit/integration test、Rust test、frontend build、
standalone CLI buildを行う。Linuxではlarge-note gate、AppImage tool test、Win32 Clipboard/IME contractの
cross compileも行う。

## 5. Release

製品versionをpackage、Cargo、Tauri設定、changelogで一致させ、`vX.Y.Z` tagをpushすると
Linux release workflowがdraftを生成する。

1. version、third-party notice、通常検証、large-note gateを確認する。
2. release専用Tauri設定を生成する。
3. Linux AppImageとUpdater signature/`latest.json`をbuildする。
4. standalone Linux CLI、SHA-256、SBOMを添付する。
5. Windows executable/MSIが添付されていないことを確認する。
6. draft assetそのものをnative環境で手動確認する。
7. publish workflowで同じdraftを再buildせず公開する。

公開時はGitHub Releaseをlatestにする。private signing keyはGitHub Environment secretとoffline backupだけで管理し、
repositoryやartifactへ含めない。

## 6. Updater

Updaterは公式Linux AppImageだけで有効にする。release buildへ埋め込んだpublic keyでTauri artifact signatureを検証する。

- Workspace readyから約10秒後にGitHub ReleasesのHTTPS endpointを1回確認する。
- updateがあればCommand-lineへ非modalに通知する。
- 自動download/installしない。
- `:update`でrelease情報を表示し、利用者がEnterで確定した場合だけ適用する。
- offline、no update、download失敗、署名不正では現在versionとWorkspaceを変更しない。
- 適用前にCore保存と必要なportable mirrorをflushする。

source buildとWindows local buildではUpdaterを無効にし、`:update`は署名済み配布版だけで利用可能であることを通知する。

## 7. Networkとprivacy

通常のNote操作、検索、mirror、Attachment、診断ではnetworkへ内容を送信しない。
account、telemetry、広告、crash report自動送信、log uploadを実装しない。

公式AppImageの更新確認だけがGitHub ReleasesへHTTPS接続する。この際、IP addressなど通常のHTTP接続情報が
GitHubへ伝わり得る。Note本文、title、検索語、Clipboard、Attachment、Workspace pathをrequestへ含めない。

## 8. 外部contentの安全性

- HTML pasteはallowlist sanitizerを通す。
- 外部URLは許可schemeとabsolute URLを検証し、clickで自動openしない。
- Attachmentはsize、filename、MIME/magic bytes、pathを検証する。
- SVG/HTML、実行file、shortcutなどをinline previewしない。
- custom attachment protocolはWorkspaceで解決したIDだけを読み、arbitrary filesystem pathを公開しない。
- portable mirrorのpath traversal、symlink、root外renameを拒否する。

## 9. 診断log

release logはOS標準のMemoka log directoryへ保存する。

- levelはInfo以上
- 1 file最大5 MiB
- active fileと過去2 fileの合計3世代
- telemetry、自動uploadなし

固定されたoperation eventだけを記録し、Note本文/title、検索語、Clipboard内容、Attachment filename、
absolute path、Note/Section ID、signing情報を記録しない。

`:version`はapplication/Tauri/OS/architecture/bundle情報を表示し、`:diagnostics`はversion、
Updater設定状態、local log directoryを表示する。

## 10. ライセンスと脆弱性報告

MemokaはMIT License、publisherはJun Ando、公開repositoryは
<https://github.com/memoka-project/memoka>である。

Nightfox paletteなどthird-party componentは固定したupstreamとlicenseを
`THIRD_PARTY_NOTICES.md`へ記載する。releaseごとにinventoryとSBOMを生成する。

脆弱性は公開IssueではなくGitHub Private vulnerability reportingで受け付ける。
最新の安定版だけをsecurity support対象とする。
