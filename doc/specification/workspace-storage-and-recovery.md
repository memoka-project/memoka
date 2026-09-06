# Workspace保存、履歴、読み出しCLI

[仕様書へ戻る](../specification.md)

## 1. データ領域と正本

初回起動時に利用者が選択するdirectoryを1 Workspaceとする。
以後はapplication config directoryの`selected-workspace.json`へ選択pathだけを保存する。
既存領域はvalidなMemoka data areaか完全に空のdirectoryでなければ拒否する。

```text
<data-area>/
├── .memoka/
│   ├── data-area.json
│   ├── memoka.sqlite3
│   ├── attachments/objects/<SHA-256 prefix>/<suffix>
│   ├── attachments/materialized/
│   ├── migration-backups/
│   ├── backup-input/
│   └── history-cache/
└── .memoka-backups/restic/
```

SQLite内のWorkspace/Note Yjs snapshot、update log、metadataと、Attachment CASが内部正本である。
FTS、materialized file、履歴preview cacheは派生物である。SQLiteにはlocal UI stateとbackup運用stateも保存する。

常時Markdown mirrorとWorkspace一括Markdown exportは生成しない。旧版のmanifest、Markdown、
recovery file、stagingは自動削除しない。MarkdownはCLI読み出し、Clipboard、importの交換表現である。

## 2. 同一Workspaceの排他と読み出し

同じcanonical data areaを通常利用するMemoka processは同時に1つである。
GUIとstandalone CLIは同じWorkspace leaseを使う。既存GUIがあれば、新しいGUIはactivationを依頼して終了する。

CLIのcurrent readは、GUI所有中は同一ユーザー限定のowner IPCを使う。
LinuxはUnix domain socket、Windowsはnamed pipeを使い、peer identityとWorkspaceを検証する。
GUIは確定済みCore transactionの保存barrierを通した後で読み出す。未確定IME compositionを強制確定せず、
focusやcaretを移さない。IPC timeoutや保存失敗時にlive DBへfallbackしてはならない。

GUIが所有していないときはCLIがleaseを取得し、read-only SQLite transactionとnative Yjs readerで読む。
current readはmigration、Help同期、Restic初期化を行わない。旧schemaはGUIでの移行を要求する。
CLI実行時にNode、DOM、GTK、WebKit、WebViewを起動しない。

## 3. 移行前検査

database schema 2〜4から5への移行では、live/Trash/Helpを含む全documentの最終Yjs stateを検査する。
WorkspaceMetadataDoc 2をNamespace付きschema 3へ、NoteDoc 2をBodyChunk付きschema 3へ変換する。

- 元DBに書き込む前にID、Namespace、Root identity、H6上限、添付catalogを検証する。
- WALが残る場合はDBとWALのprivate copyを検査し、WALにある確定更新を無視しない。
- H6超過などの不整合では元DB、添付、旧mirrorを変更せず、対象documentと理由を返す。
- 成功後にSQLite Online Backupで移行直前のrollback copyを残し、schemaとdocument変更をatomicに確定する。
- 以前の移行試行のrollback copyを上書きせず、再試行時にもその時点の原本を保護する。
- Note/Section/Block IDと旧Tree表示順を維持し、Entry IDだけを独立して割り当てる。
- local Tree選択/foldをNote IDからEntry IDへ移す。Buffer/Jump Listのresource参照はNote IDのままである。
- 移行前から欠けていたCAS objectは`known_missing`として記録する。検査不能、破損、symlinkは欠損扱いで隠さない。

## 4. ローカル履歴

Restic 0.19.1を同梱し、`.memoka-backups/restic/`へ自動保存する。
ローカルrepositoryは毎回`--insecure-no-password`を明示する。
利用者にパスワード入力を要求しないが、秘密保護のある保存先とは表示しない。

初期世代がない場合、および未包含の変更がある場合に保存する。既定間隔は15分で、
`:backup-settings`から1〜1440分に変更できる。起動時、終了時、Workspace切替、更新適用前にも確認する。
アプリ停止中の常駐serviceは作らない。`:backup`で未包含変更の保存と追加先転送を要求できる。

`content_epoch`はNote内容、Namespace配置・名前・Trash、添付catalogの確定と同じSQLite transactionで進む。
title cacheだけの変更、FTS、local UI、backup状態表示はdirty判定に含めない。
編集内容が同じでもNamespace移動はbackup対象である。

## 5. Captureと正常世代

Captureはnativeのbackground処理で行い、Editor上で全NoteのMarkdownを生成しない。
SQLiteの保存/読出し・compaction・FTSもnative workerで行い、storeのmutexやDB lockをUI threadで待たない。
保存順序とrevision検査は従来のCore journalとstoreの排他で維持する。
SQLite Online Backupで得たDB内のepoch、document revision、添付catalogを採用する。
capture前に別々に読んだlive revisionを混ぜない。

保存対象は固定allowlistの`backup.json`、`state.sqlite`、`blobs/<SHA-256>`である。
添付catalogにあるlive、Trash、未参照objectをすべて対象にし、同じhashは重複保存しない。
immutableなCAS objectをhard linkできない場合はcopyし、size/hashを確認する。
migrationで記録したknown missingはdescriptorへ明示する。新たな欠損や破損で世代を成功扱いしない。

generation IDはMemokaのUUIDv7で、Restic snapshot IDとは分離する。
descriptorはcapture時刻とtimezone、Workspace ID、epoch、document revisions、Section所有者、
DB/添付hash・size・schemaを持つ。Restic exit 0だけでなくsnapshotのfile集合・型・sizeも検証して受理する。
exit 3、不明file、未知schema、path traversal、symlinkは正常世代にしない。

正本保存用に1 GiBとDB copy等の必要量をreserveする。容量不足や途中失敗でも最後の正常世代を保持する。
ローカルrepository IDの欠損・不一致を、空のrepositoryへの自動初期化で隠さない。

## 6. 追加ローカル保存先

ローカル履歴を常時有効・パスワードなしで残したまま、追加先を件数上限なく設定できる。
`:backup-settings`でWorkspace外の親directoryを選び、その下の専用`memoka-<workspace-id>`へ保存する。
Workspaceとの相互包含、既存の不明repository、空パスワードを拒否する。

追加先は独立した暗号鍵でRestic initし、ローカル世代をsnapshot copyする。
ローカルrepositoryのfile copyとパスワード変更で代用しない。
パスワードはOS資格情報ストアへ保存し、必要なRestic childだけの環境変数へ渡す。
argv、設定file、通常log、Command-line履歴には入れない。既存パスワードの再登録UIを持つ。
保存先ごとに独立した資格情報を使う。再登録は入力した既存パスワードとrepository IDを検証してから更新し、誤パスワードで既存資格情報を上書きしない。
作成済みrepositoryのパスワード変更機能は含めない。

保存先は安定したIDを持ち、有効状態と保持設定を個別に保存する。無効状態は再起動後も保持する。
無効な保存先は転送・保持整理・prune・終了待ちから除外する。実行中の処理単位は完了させ、次の処理単位を開始しない。
設定、資格情報、保存済みrepositoryは維持する。再有効化時は残存local世代を新しい順に転送し、停止中にlocalから整理された未転送世代は期限切れとして記録する。

追加先がoffline、鍵が取得不能、容量不足でも編集とローカル履歴は継続する。
転送は新しいcaptureから試み、GUIの1回の転送試行には時間上限を設ける。
ローカル追加先の転送は直列のbackground処理とし、GUIの全体30秒予算は設けない。個別Restic commandの1時間上限は維持する。Google Driveの通常転送は別workerで行う。試行後に次回開始先を巡回させ、未接続・低速な保存先が他の保存先を恒久的に妨げない。
時間切れや未処理の保存先を成功扱いしない。CLIの明示copyは従来どおり1時間の予算を持つ。
同じgenerationを重複作成せず、元のcapture時刻を維持する。
転送待ち、転送済み・検証待ち、転送機会の期限切れ、追加先で保護済みのcapture時刻を区別して表示する。
追加先を変更したとき、以前の保存先への転送済み判定を流用しない。
転送台帳、保護済みcapture日時、最終転送日時、転送待ち・期限切れ件数、エラー、整理状態は保存先IDごとに独立管理する。
status取得はSQLiteの運用stateと実行中process内の進捗だけを読み、保存先やOS資格情報ストアへ接続しない。
`status.destinations[id].progress`は任意の診断fieldで、schema 3の追加fieldとする。工程、処理世代のcapture時刻、
完了/対象世代数、処理単位/工程の経過ms、最終進捗時刻、実行中command種別、完了command数、数値通信統計を持つ。
生のstdout/stderr、file名、OAuth情報、秘密を含めない。実行中の統計はメモリだけに更新し、状態pollでDBへ書き込まない。
処理終了時にsummaryを運用stateへ保存する。失敗・中断では工程を成功に変更しない。世代の完了数は表示中の工程に対する値であり、転送完了と検証完了を同一視しない。
GUIは約2秒ごとに取得し、世代数のprogressと通信量（読み書き合計）を区別する。未計測値を0や推定ETAで代用しない。

backup設定schema 3は`local_retention`と`destinations`配列を持つ。各保存先は`location`判別unionと`credential_ref`を持ち、ローカルは`{kind:"local-directory",path}`、Googleは`{kind:"google-drive",connection_id,root_folder_id,display_name}`である。
schema 2の`path`/`credential`、旧単一`additional`、status、転送台帳、初期化途中のintentは1 transactionで移行し、順序、有効状態、保持値、repository ID・資格情報参照・運用履歴を維持する。未知schema/locationは拒否する。
設定の移行だけでNote、content_epoch、バックアップ形式を変更せず、repositoryを再初期化しない。設定のない新規・復旧Workspaceのstatus/config取得は書き込みを行わない。
初期化成功後に資格情報保存が失敗してもintentを保持し、再試行時に同じrepositoryを検証して登録する。

解除はrepository自体を削除しない。別PCでの復旧に備えパスワードを別途保管する必要がある。
同じ物理媒体にある2つのrepositoryは、その媒体の故障に対する二重化ではない。

### 6.1 Google Drive（実験的）

同梱rclone 1.75.1の`serve restic --stdio`をResticの転送路として使う。ローカルの正常世代を
独立した鍵のrepositoryへ`restic copy`する。repositoryのfile copy、sync、mount、常駐daemonは使わない。
初版はマイドライブのMemoka専用新規folderに限定し、Shared Drive、service account、任意backendは受け付けない。
表示名で場所を特定せず、作成応答で得たfolder IDと検証済みrepository IDを保持する。

Google接続はOSユーザー単位でWorkspace外へ保存し、複数保存先から共有できる。OAuth tokenとResticパスワードは別の秘密である。
専用Desktop OAuth client未設定時はGoogle接続だけを無効化する。OSブラウザ、loopback callback、state、PKCE S256を用い、
要求scopeは`drive.file`のみ。これは専用folderだけのOAuth権限ではなく、アプリが扱えるfileへの権限である。
再認証は別の暗号化configで行い、同じclient/account、scope、登録root・repository IDの検証後に切り替える。

登録はWorkspace ID・destination ID・nonce・実folder ID・repository ID・phaseを持つintentで再開する。
folder作成応答が不明な場合はnonce照合し、未発見/複数候補では再作成しない。init後の鍵保存失敗は同じパスワードで再試行する。
既存root消失、権限不足、repository mismatchを自動initで隠さない。同一Workspaceの同一repository二重登録を拒否する。

通常Google転送は1世代の転送、検証、または整理単位に最長1時間を割り当て、1単位ごとに保存先を巡回する。
新規編集がなくても約1分ごとのscheduler tickでpendingを再評価する。新しい世代の作成は実行中のcopyを中断しない。
自動転送はuploadを先に完了し、検証・整理は30秒以上入力操作がないidle判定時のtickで開始する。明示的な「今すぐ転送」も検証・整理を再試行できる。
複数先に転送できるデータがある場合、後続の検証・整理よりuploadを優先する。
copy前には接続先identityとローカルsourceを確認するが、毎回のremote全世代一覧・検証は行わない。
成功したcopyは期待descriptorを`TransferLedger.awaiting_verification`に永続化し、転送待ちから外す。`delivered`・保護済み日時は進めない。
世代完了時の台帳・件数・保護済み日時は同じSQLite transactionで更新し、途中終了やDB書込み失敗で不整合にしない。
`pending_verification_count`と`verification_error`はschema 3の追加fieldとし、旧stateでは0/nullとする。
転送後の検証失敗を転送失敗と混同せず、検証や整理の一時障害のbackoffで新規uploadを遅延させない。identity/認証等の重大な問題は全工程を保留する。
転送後の照合はWorkspace/generation tagで今回の世代に絞り、descriptorとfile集合を検証する。
source/targetのsnapshot IDが異なることを許容する。copy応答喪失後はResticのsource snapshot identityによる冪等copyで再試行し、未確認の世代を保護済み扱いしない。
検証成功時だけ`delivered`と保護済み日時を進める。検証待ちは再起動後も再開し、local sourceの保持期限後も期待descriptorと比較できる。
転送済み・未検証世代はlocal保持整理で「未転送の期限切れ」に変更しない。検証待ちが残る追加先のforget/pruneは保留する。
検証済みsnapshot/repository IDの組に対する結果は再利用し、無関係な全世代の再検証をcopyのたびに行わない。
Google転送jobはowner-onlyの一時Restic cacheをcommand・世代間で共有する。ユーザーの既存cacheは使用せず、
通常終了・中断で子process回収後に破棄する。明示的な`check`はcacheを無効にし、repositoryの実体を検査する。
接続・repository leaseを持つhandleの生存中だけ、open時に照合したrepository IDを一覧取得・保持計画で再利用する。
別jobへ持ち越さず、後続の転送後検証と実削除前は最新のIDを再照合する。ID取得の`cat config`だけは`--no-lock`で復号して読み、
確認のたびにDriveへlock fileを書き込まない。snapshot/fileの読み取り、copy、forget、pruneのRestic lockは維持する。
一時障害は指数backoff（最大1時間に0〜30秒のjitter）を持ち、認証失効・鍵取得不能・権限/容量不足・repository不一致や不明なlayoutは明示操作まで保留する。
ネットワーク待ち中はCore mutexを持たず、copyのsource-reader leaseはCapture追加・履歴readを許可し、sourceのforget/pruneだけを除外する。
無効化はGoogle workerへ中断も要求する。再接続、明示転送、中断、既存パスワード再登録、無効化、解除は独立した操作である。

接続解除はこの端末の資格情報だけを除き、Googleのproject認可をrevokeしない。利用先がある場合は一覧を示し、
先に各保存先を解除するか、共有接続の全利用先を停止すると明示確認する。後者は非秘密の接続/保存先参照を残し、再認証で復帰する。
Google上のfolderと世代は削除しない。status/設定の通常表示はmetadataだけで、Googleや資格情報ストアへ問い合わせない。

ユーザーによる実Driveの接続・保存先登録と一部世代の転送は確認済みである。
**token更新・認可取消後の再アクセス・別OSプロファイル復旧は未検証であり、正式提供可とは判定しない。**
OAuth client変更で以前のbackupにアクセスできる保証はなく、scopeの自動拡大や空repositoryへの置換は行わない。
設定手順と受け入れ試験の結果は[Google Drive開発・検証記録](../development/google-drive-backup.md)を参照する。

## 7. 保持と容量回収

正常世代へ直近・日次・月次のOR条件を各repositoryで独立適用する。既定は直近48世代・日次30世代・月次12世代である。
ローカルを含めrepositoryごとに変更できる。直近は1以上、日次・月次は0以上の整数（u32）、0はその条件を無効にする。
日次・月次は保存のある日・月について最新を保持する。設定保存では削除せず、次の保持整理から適用する。
Resticのcalendar policyを使い、Workspaceごとに1つの集合として扱う。
hostname、capture一時path、generation tagごとに保持集合を分割しない。

dry-runのkeep/remove集合を確認済みsnapshot集合と照合し、最新正常世代が残ることを検証してから、
明示したsnapshot IDだけをforgetする。追加先にしかない世代を、localから消えたという理由では削除しない。
候補はWorkspace tagで絞り、引数長が世代数に比例しないようにする。不明なmatching snapshot等で集合が一致しない場合は削除を中止する。
実際のforgetは検証済みIDを128件ずつ指定する。
copy中はsource repositoryのleaseを保持し、retention/pruneと競合させない。

正常世代数が「直近」の保持数以下で、pruneも不要なら、全世代を残せるためResticの`forget --dry-run`自体を省く。
削除やpruneを行う場合はこの省略を使わず、確認済み集合との照合・最新世代保護・実行前ID再照合を行う。
削除不要の確認時刻と実際のprune時刻は別に記録する。idle巡回では保持設定変更、保持数を超える新しい正常世代、
または前回確認から24時間経過時に再評価する。prune不要なのに毎分Driveを再確認することはしない。

forgetとpruneは別処理である。pruneは世代削除や中断した書き込み等による回収待ちがある場合に限り、
30秒以上入力操作がないidle時に開始し、各repositoryで24時間に1回まで行う。
capture/copy/forgetの書き込み前に回収待ちを運用DBへ記録する。正常capture/copyは今回分だけを解除し、
以前の中断・失敗で残った回収待ちはprune成功まで保持する。回収待ちは再起動しても失わない。
この記録を導入する前の未参照データも、次に必要になったpruneで合わせて回収する。
`backup maintain`でも実行でき、`--dry-run`では変更しない。
capture/copy失敗の直後に成功後cleanupとして世代を減らさない。
prune失敗はaccepted backupを未作成へ戻さず、maintenance errorとして表示する。

Googleは1世代のcopy後に別の整理単位を巡回する。整理前には専用root内の元のDrive metadataで
同名object・shortcut・Google Docs・不明なrepository layoutを検査し、不整合があれば停止する。
`drive_use_trash=true`を明示し、削除objectはDriveのゴミ箱へ送る。repository整理成功はGoogleの空き容量増加と同義ではない。
`cleanup`、`emptyTrash`、自動dedupe、未確認の完全削除や強制unlockを実装しない。

## 8. 終了・切替・キャンセル

OS close、`:quit`、`:q`、`:qa`は共通shutdown処理を使う。
確定Core保存を先にflushし、未包含変更のローカル履歴と追加先への転送を待つ。

終了・Workspace切替・Updaterは同じ進捗overlayで、保存中、履歴作成・転送中、編集復帰中、中断待ち、実行中、失敗を区別する。
再試行、操作のキャンセル、バックアップだけを中断して続行する選択肢を用意する。
省略はCore保存成功後に限り、正本保存の失敗を無視して終了する選択肢は提供しない。
「終了/切替/更新を取り消す」（Esc/Ctrl-cを含む）はdeparture待機だけを解除し、開始済みのcapture/copy/検証を継続する。
進捗pollと未開始の最終capture待機を解除し、転送のcancel token・失敗状態・保護済み日時には触れない。
nativeのdeparture待機は操作IDに所属させ、取消済み操作の遅延応答や解除が新しいdepartureへ作用しないようにする。
CLI単独実行の転送待機はGUIのdepartureに所属せず、GUIの操作取消では解除しない。
「バックアップを中断して続行」だけが処理全体に属するtokenで後続phaseも停止し、子processの回収後に完了する。
LinuxではRestic本体だけへSIGINTを送り、rcloneを生かしたまま最大20秒のlock解除猶予を与える。
Windowsの非console childでは自然終了を同じ上限まで待つ。正常解除を保証するものではない。
猶予を過ぎたらprocess group / Job Objectの子孫まで強制終了・回収し、leaseを解放する。

終了・切替・更新の追加先待機には時間上限を設けず、30秒でtimeoutにしない。通常の1時間処理上限と接続・無応答timeoutは別に維持する。
終了準備の開始時にnative workerを転送優先・後続検証/整理保留へ切り替える。進行中の単位は中断せず、その完了を待つ。
未開始の検証・整理は終了を妨げず、検証台帳から次回起動後に再開する。操作取消で通常のidle検証を再び許可する。
未検証は保護済みではなく、転送後の検証エラーだけで終了を阻止しない。GUIにこの違いを表示する。
明示中断ではResticとrcloneの子孫まで終了し、lease解放を待つ。キャンセル後に遅れて届いたtickは再開操作まで拒否する。

ローカル成功/追加先のみ失敗は別表示し、追加先未完了を自動的に無視して切替・更新へ進まない。
`:switch-workspace`では旧EditorをCore保存とバックアップの完了までmountしたまま保ち、旧controllerは切替後に再開しない。
新領域のvalidation/lock/load失敗で元Workspaceを捨てない。
旧`shutdown.wait_for_mirror`設定は既知の廃止keyとして無視し、残っていても他のkeymapをリセットしない。

## 9. 履歴参照UI

`:history`はactive Noteの世代一覧を開き、NoteがなければWorkspace世代一覧を開く。
共通検索paneにcapture時刻と読み取り専用previewを表示する。
現在文書へ過去Yjs updateを適用せず、編集、Undo、autosave、Help同期に接続しない。

過去DBは検証後に必要時だけ取り出し、preview cacheは既定で3世代までとする。
リンクと添付は同じ世代から解決し、現在のタイトル・添付で代用しない。
添付は明示操作で新しいfileへ取り出せる。履歴から現在Noteへのin-place restore/mergeは行わない。

## 10. 読み出しCLI

```bash
memoka-cli tree --workspace <dir> --format json
memoka-cli search "検索語" --workspace <dir> --format json
memoka-cli read --id <note-or-section-id> --workspace <dir> --format markdown
memoka-cli read --id <note-or-section-id> --workspace <dir> --format json
memoka-cli attachment get --id <attachment-id> --output <new-file> --workspace <dir>
memoka-cli history --id <note-or-section-id> --workspace <dir> --format json
```

`--workspace`省略時は選択済みWorkspaceだけを使い、cwdから推測しない。
`--generation`で過去世代を指定できる。Trashは既定で除き、明示的な`--include-trash`を要求する。
`--limit`は最大1000、`--cursor`はqueryと確定revisionに結び付き、変更後の再利用は拒否する。

JSONは`schema_version: 1`とresource ID、source revision/generation、読取時刻を持つ。
Markdownはheading、mark、list、table、callout、Source Block、image widthを保持する。
参照には`memoka://workspace/<id>/section/<id>`または`attachment/<id>`の論理URIを使い、
内部CAS path、資格情報、任意host fileを公開しない。外部URLをfetchしない。

## 11. バックアップ運用CLIと復旧

```bash
memoka-cli backup run --workspace <dir>
memoka-cli backup status --workspace <dir> --format json
memoka-cli backup list --workspace <dir> --format json
memoka-cli backup copy --workspace <dir>
memoka-cli backup maintain --workspace <dir> --dry-run
memoka-cli backup check --repository <repo-dir> --insecure-no-password --full
memoka-cli backup restore --repository <repo-dir> --generation <generation-id> --target <empty-data-area> --insecure-no-password
```

GUI所有中の運用commandもownerへ依頼し、同じschedulerとrepository leaseを使う。
`backup status`・`run`・`copy`・`maintain`のJSON応答はtyped locationに対応する`schema_version: 3`である。
statusは`config.destinations`配列と`status.destinations`のID別state、run/copy/maintainは保存先ID別の結果を返す。
GUIの`:backup-status`は廃止し、`:backup-settings`へ統合する。CLIの`backup status`は維持する。
repository単独でlist/check/restoreでき、現在DBが壊れていても復旧できる。
追加先では`--insecure-no-password`の代わりに`--password-stdin`または対話入力を使う。
パスワード文字列を引数で渡すoptionはない。誤パスワードから空パスワードへfallbackしない。

復旧は別の空directoryへのみ行う。source/repository内、非空target、既存Workspaceへの上書きは拒否する。
allowlistだけをprivate stagingへ取り出し、DB integrity、Yjs replay、Namespace、H6、添付hashを検査し、
完成してから公開する。IDとdocument revisionは維持する。
復旧先のlocal repository設定、転送queue、accepted-state、lock、local UI、検索index等の運用派生stateはリセットする。
次回GUI起動時に新しいローカル履歴を作る。GUIに`:restore`や一括export commandは設けない。

### 11.1 Google接続とrepository単独復旧

```bash
memoka-cli cloud connect google-drive --name recovery --client-file /absolute/google-desktop-client.json
memoka-cli cloud list --format json
memoka-cli cloud reconnect --connection <id> --client-file /absolute/google-desktop-client.json
memoka-cli cloud disconnect --connection <id>
memoka-cli cloud disconnect --connection <id> --stop-destinations
memoka-cli backup list --connection <id> --drive-folder-id <folder-id> --password-stdin
memoka-cli backup check --connection <id> --drive-folder-id <folder-id> --password-stdin --full
memoka-cli backup restore --connection <id> --drive-folder-id <folder-id> --generation <generation-id> --target <empty-data-area> --password-stdin
```

接続操作とpassword入力は別commandにし、stdinを競合させない。`--no-browser`はこの端末のloopback URLを自動openせず表示する。
OOB code貼り付け認証ではない。GUIや元Workspaceを要求せず、OS資格情報ストアを使う。keyringなしで平文保存するfallbackはない。
`--repository`とcloud locatorは排他的で、Googleへの`--insecure-no-password`を拒否する。
復旧情報にはprovider/root ID/Workspace ID/repository ID/OAuth profile・client IDだけを明示コピーでき、秘密を含めない。
元接続IDは端末ローカルなので同じ値でなくてよいが、同じOAuthアプリでの再認証後の実Drive復旧試験は上記のとおり未実行である。
CLIのCtrl-C/SIGTERMは子孫の回収を伴う中断とする（SIGKILLやOS crashの正常回収は保証しない）。

## 12. 旧portable mirror互換

```bash
memoka-cli verify --source <old-portable-mirror>
memoka-cli restore --source <old-portable-mirror> --target <empty-data-area>
```

旧manifest v1の検証・復旧だけを残す。marker、manifest、file集合、size/hash、path、symlink、
Yjsの最終状態、Namespaceへの移行可能性、H6上限を検査する。
復旧元は変更せず、検証済みrecovery documentを現行schemaへ変換する。
旧mirror復旧に限りrevision 1のfresh baselineを作る。Restic復旧のrevision維持契約とは区別する。
旧update log、Undo、FTS、local UIは復元しない。
