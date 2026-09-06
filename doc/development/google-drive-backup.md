# Google Driveバックアップ: 開発・検証記録

[現行仕様](../specification/workspace-storage-and-recovery.md) / [ユーザーHelp](../help.md)

## 1. 状態と試験環境

実装は実験的。**正式有効化・公開可とは判定していない。** Google OAuthプロファイル・実アカウントは未提供のため、実Driveの認証、token更新、認可取消後の再アクセス、別OSユーザー/別PC復旧は未実施である。ローカルのfakeをこれらの成功結果として扱わない。

- 開始点: `develop`, `9c875603fef9d32550d9b4ddb7a454c188478814`。この記録はその後の未commit変更に対応する。
- 試験日: 2026/09/06（Asia/Tokyo）。
- 実行環境: Ubuntu 26.04 LTS、Linux 7.0.0-29-generic、x86_64。
- Memoka: 0.1.8。Restic: **0.19.1（変更なし）**。rclone: **1.75.1**。
- OAuthプロファイル: 未設定。実Googleアカウントを使用していない。
- Windows x64の配布binary hashは確認したが、今回のWindows実機試験は未実施。
- 既存ユーザーWorkspace・Googleファイルは試験に使用しない。一時Workspaceと合成資格情報で試験する。

## 2. 実装上の選択

- 転送は`restic copy` → `rclone serve restic --stdio`。rcloneによるrepositoryファイルの複製、mount、daemon、独自同期は実装しない。
- rclone側の初期OAuth実装を固定版sourceで確認したところ、DriveのflowにPKCEがないため、初回認可だけRustの`oauth2` 5.0.0で行う。state、PKCE S256、ランダムなloopback portを使う。認可後のtoken保存・更新は暗号化されたrclone configに一本化する。
- `rclone config encryption set`をtoken投入**前**に実行する。非対話config protocolで受け付ける質問を限定し、秘密の回答は子process環境へ渡す。token/passwordをargvへ含めない。
- Googleの固定endpointを使うnative metadata処理は、account確認、専用folder作成、nonce照合、元object種別・重複名の検査に限定する。Resticファイルの転送を独自実装しない。
- 設定/運用応答schemaを3に上げる。`LocalDirectory`と`GoogleDrive`を判別可能な型で分離し、旧schema 2と単一`additional`をtransaction内で移行する。Note/Namespace/Capture形式は変えない。
- 接続の秘密はOSユーザー側へ保存する。Workspace DBへ入るのは接続ID・folder ID・repository IDなどの参照。別Workspaceを含む接続leaseとrepository ID leaseで競合を拒否する。
- 通常cloud workerは1世代/整理単位で最長1時間。ローカル先の30秒予算、終了・切替・更新時の追加先待機30秒とは別である。転送単位が終わるまで新Captureで破棄しない。
- source-reader leaseはCapture/履歴readを許可する。sourceのforget/pruneは除外し、idleで要求されたlocal保持整理には成功した転送単位の間でも実行機会を与える。
- Linux process group、Windows Job ObjectでResticとrcloneを所有し、cancel/timeout時に子孫をkill/reapしてからleaseを解放する。CLIのCtrl-C/SIGTERMも中断として扱う。
- backendの削除は明示的な`drive_use_trash=true`。全Driveのcleanup、ゴミ箱消去、dedupe、強制unlockは実装しない。

主要コードは`src-tauri/src/cloud/`、`rclone.rs`、`sidecar.rs`、`private_files.rs`、`credentials.rs`、`backup_settings.rs`、`backup_management.rs`、`native_service.rs`、`cli.rs`。
UIは`BackupDialog.tsx`、`BackupFields.tsx`、`CloudBackupSettings.tsx`に集約する。

## 3. 所有者が用意するGoogle設定

Google側の設定・認可は所有者が実施する。Memokaや開発用agentが自動的にprojectやGoogle内のデータを作る手順ではない。

1. Memoka専用のGoogle Cloud projectを用意し、Google Drive APIを有効にする。
2. OAuth同意画面のアプリ情報、サポート連絡先、公開する場合のホームページ・Privacy情報を設定する。試験中は対象アカウントをtest userに追加する。
3. OAuth clientの種類は**Desktop app**とする。Web application、service account、rclone共用clientは使用しない。
4. data accessは`https://www.googleapis.com/auth/drive.file`だけとする。これは特定folderだけの権限ではなく、このアプリがアクセスできるファイルに関する権限である。問題回避のために`drive`へ広げない。
5. client JSONをダウンロードし、repository外のローカルファイルへ保存する。`installed.client_id`と`installed.client_secret`を持つGoogle形式を使用する。tokenのJSONではない。
6. 下記のいずれかでMemokaへ指定し、`:backup-settings`から明示的に接続する。同じclientを復旧時にも使えるよう保管する。

Desktop clientは配布物から識別情報を抽出できるため、client secretを隠すことだけに安全性を依存させない。個人のrefresh token・Restic passwordとは分類が異なる。
手順の根拠は[Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)と[Drive scopeの公式説明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

Testing状態ではrefresh tokenが通常7日で失効する条件がある。試験用アカウントで動いたことを長期バックアップ成功と取り違えず、公開設定・token期限を確認する。[Googleのtoken有効期限](https://developers.google.com/identity/protocols/oauth2#expiration)

### source build / ローカル実行

ファイルの絶対pathを環境変数`MEMOKA_GOOGLE_OAUTH_CLIENT_FILE`へ設定して起動する。
内容をコマンドへ展開する必要はない。

```bash
MEMOKA_GOOGLE_OAUTH_CLIENT_FILE=/absolute/private/google-desktop-client.json corepack pnpm tauri:dev
```

または標準設定directoryの`dev.memoka.desktop/google-desktop-client.json`へ置く。
Linuxは通常`$XDG_CONFIG_HOME`または`$HOME/.config`、Windowsは通常`%APPDATA%`の下になる。
ファイルと祖先directoryのsymlink/reparseを拒否する。個人用ファイルは他ユーザーへ公開しないアクセス権で保管する。

CLIは`cloud connect/reconnect --client-file <absolute-path>`で同じ形式を受け取る。
配布用にはcompile時の`MEMOKA_GOOGLE_DESKTOP_CLIENT_JSON`による組み込みにも対応するが、今回のCIへ実値は設定していない。
正式ビルド用clientを変更すると既存バックアップへのアクセスに影響し得る。release前に非秘密のclient識別情報と移行条件を記録する。

未設定でも通常編集・local履歴・local復旧は使える。Google接続操作だけが未設定として無効になる。

### 秘密の保存と解除

`dev.memoka.desktop/cloud-connections/`はWorkspace外のOSユーザー設定directoryに作られる。
接続metadata、暗号化config、非秘密の初期化intent・leaseを持つ。config暗号鍵はOS資格情報ストアにあり、Restic passwordとは別keyである。
Linuxのprivate directory/fileは0700/0600、Windowsは保護DACLを使う。userの既存`rclone.conf`は読まず変更しない。

資格情報ストアが使えなければ接続/復号を失敗させる。headless CLIでもOS資格情報ストアは必要で、平文fallbackはない。
共有接続を解除する場合は利用先一覧を確認し、保存先を先に解除するか、全利用先停止を明示する。Google認可のrevokeやremote削除は行わない。
後者は参照を残してローカルconfig/keyを除くので、再開には再認証が必要になる。

## 4. オフライン成立性検証

`scripts/test-rclone-boundary.mjs`は、**実際の固定版Restic/rclone**を使うが、転送先はテスト専用local backendである。
本番APIはこのbackendを受け付けない。以下を確認する。

- token投入前のconfig暗号化と限定された非対話config protocol
- 独立した暗号鍵のrepository init、sourceのchunker parameter参照
- `rclone serve restic --stdio`経由のcopy/list/check/dump/restore
- 同一世代の再copyで重複しないこと、capture時刻/tagの保持
- 空白・日本語を含むbinary/config path
- 明示的な長時間試験では、rate limitで30秒超へ延ばした転送の完了とfull check

```bash
corepack pnpm restic:prepare
corepack pnpm rclone:prepare
corepack pnpm test:rclone
MEMOKA_TEST_LONG_CLOUD_COPY=1 node scripts/test-rclone-boundary.mjs
```

上記は実行済みで合格。長時間試験は通常`verify`へ含めず、release前に明示実行する。
この結果はGoogle scope、再認可、Driveのquota/ネットワーク実動作、GUI操作感の検証を代替しない。

## 5. 回帰試験と配布確認

```bash
corepack pnpm verify
corepack pnpm cli:build
corepack pnpm tauri:build
dbus-run-session -- corepack pnpm tauri:history-e2e
corepack pnpm release:notices
```

全体検証とnative配布確認の実行結果は以下のとおり。Google/Windows実機の未実施項目とは区別する。

| 項目                                                                              | 結果                                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| pinned Restic/rclone prepare、Linux/Windows artifact SHA                          | 合格                                                                                                          |
| `test:rclone`と30秒超の明示転送                                                   | 合格（local transport）                                                                                       |
| config migration、OAuth loopback、private file/lease、redaction、cloud UI単体試験 | 合格                                                                                                          |
| `verify`                                                                          | 合格（format/spec/lint/typecheck、frontend全件、sidecar境界、Rust 109件＋CLI 5件、production frontend build） |
| standalone CLI release build / headless依存確認                                   | 合格（両sidecarとmanifestをstage/hash照合。`ldd`にGTK/WebKit/JavaScriptCoreなし）                             |
| Linux GUI build / AppImage内sidecar確認                                           | 合格（unsigned deb/AppImage生成、展開して両sidecar SHAとlauncherを照合）                                      |
| Tauri namespace/history E2E                                                       | 合格（実ローカル履歴、並行編集、Google未設定panel、modal/focus/終了）                                         |
| Windows native GUI/CLI、ACL、Job Object、ブラウザ起動                             | 未実施                                                                                                        |
| 実Google認証・refresh・Drive転送・復旧                                            | 未実施                                                                                                        |

固定artifactと実行binaryのSHAは`SIDECARS.json`に記録する。`release:notices`はrcloneのMIT表示と固定Linux binaryの`version --deps`によるGo module一覧も生成する。
GUIのresource、standalone CLIの配布directoryにその記録とthird-party noticesを含める。CIは固定binaryを準備してテストし、Linux AppImage検査でも両sidecarの実体SHAを照合する。

補足:

- Rustの通常suiteで除外される2件（100k件FTS benchmark、93世代のcalendar保持長時間試験）は今回も未実施。通常の複数先保持試験は実行した。
- 追加で`cargo check -p memoka-desktop --tests --features windows-clipboard-contract`は合格。ただしLinux上の契約compileであり、今回追加したWindows ACL/Job Objectの実行検証ではない。
- native証拠は`evidence/generated/namespace-history-tauri.json`（2026/09/06 19:14実行、`passed: true`）。ローカルbackup中の24入力の反映p95は18ms、最大18ms、frame間隔p95は18ms。実Drive中の測定ではない。
- 分離D-Bus環境ではportal/secret proxyの警告が出たが、local履歴とGUI試験は成功した。Google/keyring実試験の成功とは解釈しない。
- CLI buildとnative E2Eを並行実行した際、使用中Resticの再配置が`ETXTBSY`で失敗した。E2E終了後に`cli:build`を再実行して成功し、配布directoryを再stageした。
- release公開・実OAuth値のCI登録は実施していない。Google正式有効化の判定は7章の実試験後に行う。

## 6. 受け入れID別の状況

「合格」は記載した実行環境・試験範囲の合格。「部分」はオフライン検査/共通経路だけの合格であり、当該ID全体の受け入れ完了ではない。
「未実施」は実Googleなどの前提不足。**部分/未実施が残るため正式提供のgateは閉じている。**

| ID      | 状態   | 根拠 / 残る確認                                                                                                       |
| ------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| MIG-01  | 合格   | schema 2複数先のID・順序・有効状態・保持・credential参照・ledger保存試験                                              |
| MIG-02  | 合格   | singleton/intent移行、local init/credential保存失敗からの再開試験。cloudの障害再開はREPO-02で別評価                   |
| MIG-03  | 合格   | Note/content_epochのsentinel不変、Capture形式変更なし                                                                 |
| MIG-04  | 合格   | fresh/read-only status取得、未設定cloud listの書込みなし、metadataとkeyring/network経路の分離                         |
| MIG-05  | 部分   | 未知schema/location、folder ID、local path拒否試験合格。Windows reparse実機は未実施                                   |
| AUTH-01 | 未実施 | 実Desktop client・実Driveが必要                                                                                       |
| AUTH-02 | 部分   | 実loopbackでstate不一致・拒否・cancel・timeoutを検査。実Google callback再送は未実施                                   |
| AUTH-03 | 部分   | 127.0.0.1のport 0で実listener試験合格。Windowsの競合環境は未実施                                                      |
| AUTH-04 | 未実施 | 実token失効後のrefresh、暗号化config更新、再起動継続が必要                                                            |
| AUTH-05 | 部分   | 別client/locked store/取消で旧metadata/key不変。別Google accountとの実照合は未実施                                    |
| AUTH-06 | 部分   | fake資格情報で共有接続の一先解除・全停止を検査。複数実Drive先は未実施                                                 |
| AUTH-07 | 合格   | fixed scope/client、未設定エラー、自動scope拡大/自動再認証なしの経路・試験                                            |
| SEC-01  | 部分   | secret-safe argv、出力分類、DOM value属性なし・送信/unmount後の消去試験。実tokenの全経路監査は未実施                  |
| SEC-02  | 部分   | 実rclone暗号化とLinux残骸/mode/symlink試験。Windows ACLと実refresh失敗は未実施                                        |
| SEC-03  | 部分   | 専用config・固定root・ambient/explicit環境の除去試験。実user rcloneとの同時利用は未実施                               |
| SEC-04  | 部分   | 別process lease競合/再取得試験。GUI/CLIの実token同時更新は未実施                                                      |
| SEC-05  | 部分   | fake locked/missing storeで拒否、空password拒否。実OS keyringのロック状態は未実施                                     |
| SEC-06  | 部分   | ID/path/profile/JSON上限とunknown layout検査。実Drive不正応答・Windows pathは未実施                                   |
| SEC-07  | 部分   | 共通sanitized環境のsecret/backend override除去試験。実ブラウザprocess検査は未実施                                     |
| REPO-01 | 未実施 | 実専用root作成とrename後のID継続が必要                                                                                |
| REPO-02 | 部分   | lost folder POSTをfake metadata APIで再現しnonce照合/重複拒否。実Drive init/鍵保存失敗再開は未実施                    |
| REPO-03 | 部分   | registered root/ID mismatchをinitへ渡さない経路、fake/root validation。実権限喪失は未実施                             |
| REPO-04 | 部分   | 実Resticとlocal stdio transportで独立暗号鍵・tag/capture日時保持を確認。実Driveは未実施                               |
| REPO-05 | 部分   | 共通copy照合/ledger・重複copy試験。実Driveでcopy応答喪失は未実施                                                      |
| REPO-06 | 部分   | 元metadataでshortcut/docs/同名/unknown検査、危険な整理なし。実Driveは未実施                                           |
| JOB-01  | 部分   | 実Restic/rcloneで30秒超copy合格。通常GUIからの実Drive長時間copyは未実施                                               |
| JOB-02  | 部分   | source-reader/capture/history/pruneのlease試験。実Drive低速中のnative編集・Capture同時試験は未実施                    |
| JOB-03  | 部分   | 独立worker・期限・巡回設計、local複数先試験。複数実接続の低速障害は未実施                                             |
| JOB-04  | 部分   | frontend tickとpause、native世代単位worker/forced queue。実Drive pending再起動回復は未実施                            |
| JOB-05  | 部分   | HTTP/rcloneの制限理由分類とbackoff試験。実quota超過・通信断は未実施                                                   |
| JOB-06  | 部分   | departure/controller試験、期限が通常workerをcancelしないnative試験。実Drive転送中の更新/切替は未実施                  |
| JOB-07  | 部分   | Linux子孫のtimeout/cancel/reap、lease再取得合格。Windows Job Objectと実rclone通信中は未実施                           |
| RET-01  | 部分   | 共通retention testで最新保護・先別保持・localにない世代を確認。実Drive整理は未実施                                    |
| RET-02  | 部分   | source reader/writer分離、失敗時保持スキップ、idleと転送単位の分離。実Drive障害時は未実施                             |
| RET-03  | 部分   | 無効先の共通copy/maintain skip、再開pending/expired試験。実Drive中断は未実施                                          |
| RET-04  | 部分   | 本番serve引数`--drive-use-trash=true`、危険cleanup APIなし。Driveの実ゴミ箱移動は未実施                               |
| RET-05  | 部分   | UI/Helpで整理と空き容量を区別。Google使用容量の実測は未実施                                                           |
| REC-01  | 未実施 | 元Workspaceなし、同じOAuth app新規認証でlist/check/restoreが必要                                                      |
| REC-02  | 未実施 | 元config/keyringのない新OSユーザー/別PCでの復旧が必要                                                                 |
| REC-03  | 未実施 | Google認可取消後の再認証・既存root再アクセスが必要。単なるrefresh試験で代用しない                                     |
| REC-04  | 部分   | 既存restoreのpath/schema/hash/非空target拒否試験。Windows reparseと実Driveは未実施                                    |
| REC-05  | 部分   | 共通restoreでID/revision保持・運用設定除外・次のlocal履歴作成。実Driveは未実施                                        |
| REC-06  | 合格   | 通常CLI 5件、portable mirror、履歴のRust回帰試験とnative namespace/history E2E                                        |
| UI-01   | 部分   | 混在modalのjsdom/focus/form試験。Google設定追加部分のnative IME手動確認は未実施                                       |
| UI-02   | 合格   | 表示はmetadataのみ。認証開始・poll・復旧情報は独立した明示操作                                                        |
| UI-03   | 部分   | 再認証/credential/無効化/cancel/解除の分離とUI試験。実remote無変更は未実施                                            |
| UI-04   | 合格   | secretなしの復旧情報、token/passwordの違いと保管方法をUI/Helpへ記載                                                   |
| DIST-01 | 部分   | Linux GUI/CLI同梱SHAと改変binary拒否は合格。Windows artifact SHA確認済み、Windows GUI bundleは未実施                  |
| DIST-02 | 部分   | Linux空白/日本語pathで実stdio copy成功。Windows実行pathは未実施                                                       |
| DIST-03 | 部分   | release CLI build/ldd、元Workspace・sidecarなしcloud list合格。ブラウザ後の実cloud復旧は未実施                        |
| DIST-04 | 部分   | native未設定UI、sidecarなしCLI、既存local履歴、notices/Go一覧/SIDECARS/Privacy、Linux bundle確認合格。Windowsは未実施 |

## 7. 実アカウント試験と公開前gate

試験は機密を含まない専用WorkspaceとGoogleテストアカウントで行う。client ID/profile ID、OS、Memoka commit、sidecar hash、日時と結果だけを記録し、token・password・authorization codeは証拠へ残さない。

1. LinuxとWindowsでOSブラウザ認証、拒否/cancel、鍵保存後の再起動を確認する。
2. 複数の独立password先を作り、copy/list/full check/restore、folder rename、後続Captureを確認する。
3. 30秒超copy中に編集・Core保存・新Capture・履歴readを行う。終了/切替/Updaterのtimeout→再待機、中断→子孫消失を確認する。
4. token期限後の更新、同一connectionのGUI/CLI競合、keyring lock、429/403/容量不足/オフラインを確認する。
5. **元Workspace・rclone config・keyringのない別OSユーザー/別PC**で同じDesktop clientへ新規認証し、保管したfolder IDとpasswordから`backup list/check/restore`する。
6. **Google側でproject認可を取り消す**。同じclientへ再認証し、既存rootのfile集合が見えるか確認する。不可なら条件・Google応答分類・回復策を記録し、公開を止める。
7. shortcut/同名衝突/unknown objectで整理を止めること、通常forget/pruneがゴミ箱を使うことを確認する。Google全体のゴミ箱を試験の都合で空にしない。
8. Windows nativeのACL、reparse、Job Object、空白/日本語path、bundled sidecarのみを使うことを確認する。

`drive.file`の復旧にPickerや広いscopeが必要と判明した場合は別の製品判断として相談する。自動scope拡大や空repository再作成で回避しない。

## 8. 運用上の制約

- Google接続はこのOSユーザーに属する。Workspaceを復旧しても転送設定/tokenは復元しない。
- 同じclientでの別環境再認証が復旧条件。clientを消したり無計画に変更したりしない。Google認可取消後の再アクセス保証は未検証。
- 同じrepositoryへ複数PCから通常書込みする運用は初版で保証しない。Restic lockを無効化しない。
- 通常転送1時間、rclone接続10秒/IO60秒、OAuth操作5分、native metadata request30秒、終了追加待機30秒は異なる制限である。中断時はchild回収分の時間が加わる。
- capacity/quota問題に無限再試行せず、分類された状態とbackoffを示す。認証・root/ID問題は明示修復まで止める。
- 初期化応答が不明なら同じintentで再試行する。rootが見つからない/複数ある場合は新しいfolderを自動作成しない。remoteを独断で削除しない。
- 共有接続が他processで使用中なら`BACKUP_BUSY`で安全に失敗する。転送停止/lease解放後に再実行する。
- cloud整理成功はDrive使用容量削減とは限らない。ゴミ箱管理は所有者がGoogle側で判断する。
- SIGKILL/OS crashで正常終了時と同じ回収は保証しない。次回は期限切れlockを独断でunlockせず、状態を確認する。
