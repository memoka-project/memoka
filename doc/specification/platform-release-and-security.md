# Platform、配布、Security

[仕様書へ戻る](../specification.md)

## 1. 対応範囲

現行の検証対象は次である。

- Ubuntu 24.04 / 26.04 x86_64
- Windows 11 x64

macOS、ARM、Microsoft Store、apt repository、deb repository、自前CDNは対象外である。

## 2. Linux配布

公式GUI binaryはLinux x86_64 AppImageである。別途、GUIを含まないstandalone CLI archiveを配布する。

Releaseには少なくとも次を含める。

- AppImage
- Tauri Updater signature
- `latest.json`
- standalone `memoka-cli`と固定版Restic/rcloneを同梱したarchive
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

Linux・WindowsともRestic 0.19.1とrclone 1.75.1を固定し、artifactと実行fileのSHA-256を検証して同梱する。
GUIのapp bundleとCLIの隣へそれぞれ配置する。CLIはTauriのwindow/runtimeを初期化せず、実行時に
Node、DOM、GTK、WebViewを要求しない。Linuxでは`ldd`、Windowsではnative buildと実行で検証する。

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
2. release専用Tauri設定を生成し、配布するDesktop OAuth clientが正しいGoogle `installed`形式で利用者token等を含まないことを検証する。
3. Linux AppImageとUpdater signature/`latest.json`をbuildする。
4. GUI/CLI binaryに指定したOAuth client設定が組み込まれていることを検査し、standalone Linux CLI、SHA-256、SBOMを添付する。
5. Windows executable/MSIが添付されていないことを確認する。
6. draft assetそのものをnative環境で手動確認する。
7. publish workflowで同じdraftを再buildせず公開する。

公開時はGitHub Releaseをlatestにする。private signing keyはGitHub Environment secretとoffline backupだけで管理し、
repositoryやartifactへ含めない。

### 5.1 公開手順と互換性

`corepack pnpm verify`、`corepack pnpm large-note-gate`、`corepack pnpm release:check-version -- --version=X.Y.Z`、
`corepack pnpm release:notices`を実行する。native履歴・終了経路は隔離した一時Workspaceで`corepack pnpm tauri:history-e2e`を実行する。
手元の試験・CI・署名付き配布物の試験を区別し、結果はCI、`evidence/generated/`のローカル証拠、Release本文へ記録する。
仕様書へ開発経緯や過去の全試験ログを複製しない。

動作確認済みの`develop`を`main`へ統合し、通常CI成功後にtagをpushする。
`release-draft.yml`完了後、assetを取得してSHA-256、Updater署名、AppImageの起動、CLIと両sidecarを確認する。
`release-publish.yml`を対象versionで実行し、試験済みdraftをそのまま公開する。build失敗・asset不足は公開しない。

Namespace対応前のWorkspaceはDB schema 5 / NoteDoc・WorkspaceMetadataDoc schema 3へ移行する。
更新前にMemokaを閉じ、Workspace全体を外部へコピーする。移行後のWorkspaceを旧版で開かない。
H6超過・破損のpreflight拒否とrollback copyは外部バックアップの代わりではない。
常時Markdown mirrorは生成せず、既存mirrorは削除しない。旧mirrorから別の空Workspaceへの復旧CLIは維持する。

## 6. Updater

Updaterは公式Linux AppImageだけで有効にする。release buildへ埋め込んだpublic keyでTauri artifact signatureを検証する。

- Workspace readyから約10秒後にGitHub ReleasesのHTTPS endpointを1回確認する。
- updateがあればCommand-lineへ非modalに通知する。
- 自動download/installしない。
- `:update`でrelease情報を表示し、利用者がEnterで確定した場合だけ適用する。
- offline、no update、download失敗、署名不正では現在versionとWorkspaceを変更しない。
- 適用前にCore保存barrierと必要なlocal履歴をflushし、追加先copyを待つ。通常quitの「完了を待たない」方針はUpdaterには適用しない。

source buildとWindows local buildではUpdaterを無効にし、`:update`は署名済み配布版だけで利用可能であることを通知する。

## 7. Networkとprivacy

通常のNote操作、検索、履歴、Attachment、診断ではnetworkへ内容を送信しない。
Memoka独自のaccount、telemetry、広告、crash report自動送信、log uploadを実装しない。

公式AppImageの更新確認はGitHub ReleasesへHTTPS接続する。この際、IP addressなど通常のHTTP接続情報が
GitHubへ伝わり得る。Note本文、title、検索語、Clipboard、Attachment、Workspace pathをrequestへ含めない。

Google Driveを明示設定した場合は、認証と追加backupにGoogle OAuth/Drive APIを使う。
クラウド未設定・無効なら起動・通常編集・status取得でGoogleへ接続しない。Note/添付はRestic暗号文として転送するが、
IP、API request、時刻、転送量、objectサイズ、専用folder表示名まで秘匿するものではない。
独自の中継サーバーへtokenやパスワードを送らない。Google機能の実アカウント検証は未完了で、実験的な扱いとする。

### 7.1 Google認証と秘密保存

scopeは`drive.file`だけで、共用rclone client、任意endpoint、WebView内loginへfallbackしない。
rclone 1.75.1のDrive OAuthにはPKCEがないため、初回認証だけRust `oauth2`でstate/PKCE S256を実装する。
127.0.0.1の一時portを使い、認証operationごとに5分期限・cancelを持つ。以後のrefreshは同梱rcloneが担当する。
固定版のJSON config state machineで受け渡し、未知の質問はエラーにする。端末のOAuth画面を解析しない。

接続はapplication config directoryの`cloud-connections/<UUID>/`に置く。非秘密metadata、初期化intent、
revisionごとの暗号化configを分離し、metadataが指す1本だけをrefreshの正本にする。
configへtokenを入れる前にrclone標準形式で暗号化し、ランダムな復号鍵は既存OS資格情報ストアに保存する。
Resticパスワードとは別のkeyであり、Workspace DB/Captureへ入れない。keyring利用不能時の平文fallbackはない。
親directoryと更新・失敗時のside fileにもUnix 0700/0600またはWindows owner/SYSTEM ACLを適用し、symlink/reparseを拒否する。
接続単位とrepository ID単位のOS-user leaseにより、別Workspace/GUI/CLIをまたぐ並行利用を除外する。
再認証では旧configを上書きせず、新configの検証が成功してからmetadataの参照を切り替える。

### 7.2 OAuth clientの設定と配布

公式AppImageとstandalone CLIは同じMemoka用Google Desktop OAuth client JSONをcompile時に組み込む。
配布物の利用者はJSONを別途配置せず、`:backup-settings`または`cloud connect`から認可できる。
同梱はGoogleへの自動接続・利用者の認可・バックアップ完了を意味しない。

Desktop clientは配布先から抽出できるアプリ識別情報であり、`client_secret`の秘匿を安全性の前提にしない。
利用者のaccess/refresh token、認可code、Resticパスワード、config暗号鍵は同梱しない。
これは[Googleのinstalled appモデル](https://developers.google.com/identity/protocols/oauth2/native-app)に従う。
配布元はJSONをGitHub `release-signing` Environmentの`MEMOKA_GOOGLE_DESKTOP_CLIENT_JSON` secretで管理し、
GUI/CLIのbuild環境へだけ渡す。ソース、生成Tauri設定、frontend、ログ、SBOMへJSONを複製しない。
secret管理は誤露出防止であり、配布binary内での秘匿を保証しない。未設定・不正な設定の公式release buildは失敗させる。

Google Cloud側で配布元が管理する設定は次である。Memokaがproject作成や公開設定の変更を自動実行することはない。

1. Memoka用projectでGoogle Drive APIを有効にする。
2. 同意画面のアプリ情報、連絡先、ホームページ・Privacy情報を設定し、Testingの場合はtest userを登録する。
3. OAuth clientは**Desktop app**とし、Web application、service account、rclone共用clientを使わない。
4. scopeは`https://www.googleapis.com/auth/drive.file`だけとする。[Drive scopeの定義](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)に従い、自動拡大しない。
5. `installed.client_id` / `installed.client_secret`を持つGoogle形式のJSONを配布設定に登録し、元のclientを復旧時にも維持する。

Google projectの公開範囲・審査とGitHub Releaseの公開は別である。Testing状態では対象アカウントが限定され、
refresh tokenが通常7日で失効する条件もある。[Googleのtoken期限](https://developers.google.com/identity/protocols/oauth2#expiration)を確認する。
アプリ公開だけでGoogle側の条件が変わったと扱わない。

自前clientを使用する場合の解決順は、CLIの`--client-file`、環境変数`MEMOKA_GOOGLE_OAUTH_CLIENT_FILE`、
標準配置、組み込み設定である。標準配置はLinuxでは通常`$XDG_CONFIG_HOME/dev.memoka.desktop/google-desktop-client.json`
（未設定時は`$HOME/.config`以下）、Windowsでは通常`%APPDATA%\dev.memoka.desktop\google-desktop-client.json`である。
指定fileは絶対pathの通常fileに限定し、file・祖先directoryのsymlink/reparseを拒否する。
明示指定が不正でも他のclientへfallbackしない。すべて未設定ならGoogle接続だけを無効化する。

```bash
MEMOKA_GOOGLE_OAUTH_CLIENT_FILE=/absolute/google-desktop-client.json corepack pnpm tauri:dev
memoka-cli cloud connect google-drive --name recovery --client-file /absolute/google-desktop-client.json
```

sourceから配布物を作る際も`MEMOKA_GOOGLE_DESKTOP_CLIENT_JSON`をcompile環境へ設定すれば組み込める。
再認証でclientを変更すると旧folderへのアクセスを保証できないため、既存接続は同じclientを要求する。
Googleの認可取消後の再アクセス・別PC復旧は実験的機能の未検証条件として[検証仕様](validation.md#google-driveの追加検証)に残す。

## 8. 外部contentの安全性

- HTML pasteはallowlist sanitizerを通す。
- 外部URLは許可schemeとabsolute URLを検証し、clickで自動openしない。
- Attachmentはsize、filename、MIME/magic bytes、pathを検証する。
- SVG/HTML、実行file、shortcutなどをinline previewしない。
- custom attachment protocolはWorkspaceで解決したIDだけを読み、arbitrary filesystem pathを公開しない。
- 現行read・Restic restore・旧mirror restoreのpath traversal、symlink、Windows reparse pointを拒否する。
- Native read IPCは同じOS userのsocket/named pipeだけを受け付け、GUI ownerとheadless処理は同じWorkspace leaseを使う。
- 子processの継承`RESTIC_*`/`RCLONE_*`/認証・library injection環境を除去し、必要なrepository/root/config/passwordだけをchild専用環境へ設定する。任意backend URLやcredential引数は受け付けない。
- 追加先passwordはOS資格情報ストアと必要な子process環境だけへ渡す。local repositoryは明示的なno-passwordである。
- 生成物allowlistは`backup.json`、`state.sqlite`、`blobs/<sha256>`に限定し、config、token、log、cache、鍵を含めない。
- Google転送jobの一時Restic cacheはWorkspace外のowner-only directoryに置き、job終了・中断で破棄する。OS crash/SIGKILL時に残る可能性はある。
- 転送進捗は固定command種別と数値だけを公開する。rclone JSON logのmessage/object、認証情報、生の子process出力は公開しない。
- 周期的な通信統計はnativeのbounded pipeで消費し、DBへ毎秒保存しない。stderrは容量制限付きで末尾を保持し、長時間転送の末尾に出る認証/容量/通信エラーの分類を維持する。
- ブラウザopenerへbackup用secret環境を渡さない。HTTP redirect/TLS検証の無効化、任意認証endpointは許可しない。
- Restic/rcloneのstdout/stderrは上限付きで回収し、raw診断やtokenをGUI/logへ返さず、既知のerror分類だけを使う。
- Linux process group / Windows Job Objectで子孫を管理する。cancel/timeoutではLinuxのRestic本体へSIGINTを送り、rcloneでのlock解除を最大20秒待つ。Windowsの非console childでは同じ上限まで自然終了を待ち、その後の残存子孫をkill/reapしてpipeとleaseを解放する。stdioにlogを混ぜず、外部公開HTTP/rcdを起動しない。
- runtimeでは検証済み同梱binaryだけを使う。PATH/cwd fallback、self-update、実行時downloadは行わない。

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
ResticのBSD-2-ClauseとrcloneのMIT本文を同梱し、Go moduleも含めて最終配布物のSBOMへ収録する。

脆弱性は公開IssueではなくGitHub Private vulnerability reportingで受け付ける。
最新の安定版だけをsecurity support対象とする。
