# Workspace保存、履歴、読み出しCLI

[仕様書へ戻る](../specification.md)

## 1. データ領域と正本

初回起動時に利用者が選択するdirectoryを1 Workspaceとする。
以後はapplication config directoryの`selected-workspace.json`へ現在の選択`path`と、最近開いたpath一覧`recentPaths`（最大100件）を保存する。
`memoka-cli workspaces --format json`で既知のWorkspaceを読み出せる。IDやDB内容を複製するcatalogではなく、filesystemの全Workspaceを探索しない。
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
current readはmigration、Help同期、Restic初期化を行わない。読み取りは既知のDB schema 5/6/7を受け入れ、
それ以前のschemaはGUIでの移行を要求する。[CLI編集](agent-editing.md)はDB/Note schema 6・7に対応し、同期有効WorkspaceではReplica IDも検証する。
CLI実行時にNode、DOM、GTK、WebKit、WebViewを起動しない。

## 3. 移行前検査

database schema 2〜6から7への移行では、live/Trash/Helpを含む全documentの最終Yjs stateを検査する。
旧Namespace変換を経てWorkspaceMetadataDoc 4へ、NoteDocは安定IDごとに内容と配置を分離するschema 7へ変換する。
独立した候補でMarkdown・装飾・構造・Note/Section/Block/Entry ID・添付hashを比較し、不一致なら元DBを変更しない。
既存のNamespaceと旧ID対応表を維持し、同期journal等のtableとコピー固有のReplica IDを追加する。

- 元DBに書き込む前にID、Namespace、Root identity、H6上限、添付catalogを検証する。
- WALが残る場合はDBとWALのprivate copyを検査し、WALにある確定更新を無視しない。
- H6超過などの不整合では元DB、添付、旧mirrorを変更せず、対象documentと理由を返す。
- 成功後にSQLite Online Backupで移行直前のrollback copyを残し、schemaとdocument変更をatomicに確定する。
- 以前の移行試行のrollback copyを上書きせず、再試行時にもその時点の原本を保護する。
- Note/Section/Block/既存Entry IDと旧Tree表示順を維持する。Namespace対応前のschemaだけはEntry IDを独立して割り当てる。
- local Tree選択/foldをNote IDからEntry IDへ移す。Buffer/Jump Listのresource参照はNote IDのままである。
- schema 2〜4からの移行前に欠けていたCAS objectは`known_missing`として記録する。5以降の新たな欠損を再認定しない。検査不能、破損、symlinkは欠損扱いで隠さない。

## 4. ローカル履歴

Restic 0.19.1を同梱し、`.memoka-backups/restic/`へ自動保存する。
ローカルrepositoryは毎回`--insecure-no-password`を明示する。
利用者にパスワード入力を要求しないが、秘密保護のある保存先とは表示しない。

初期世代がない場合、および未包含の変更がある場合に保存する。既定間隔は15分で、
`:backup-settings`から1〜1440分に変更できる。起動時、Workspace切替、更新適用前にも確認する。通常終了では新しいcaptureを作らない。
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
descriptorのdatabase/note schemaはcaptureした実DBに合わせる。現行はDB/Note schema 7で、
読取・復旧はDB schema 5/6と旧世代のNoteDoc 3/4/5/6も受け入れる。未対応schemaは拒否する。
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

一覧の保存世代は「検証済み／転送済み／保存対象」の3値で表示する。検証済みは保存先に現在残る確認済み世代、
転送済みは検証済みと転送完了・検証待ちの集合、保存対象はそれに今後転送可能なlocal世代を加えた集合である。
追加先だけに残る古い世代を含める。追加先の保持整理で削除済みの世代を累積転送台帳から再加算せず、未転送のまま期限切れの世代も除外する。
ローカル履歴は保存・検証完了数を3値共通で表示する。保存対象数は保持設定の上限や未captureの編集数ではない。
statusとdestinationsの`generation_counts`は`{verified,transferred,target}`または`null`で、未確定値は`—`と表示する。
件数は既存の世代catalogと転送台帳のID集合からbackground/configuration書き込み時に集計し、status pollは保存済みの小さな集計だけを読む。
表示目的でResticや外部通信を起動しない。保持削除は実行前にinventoryを未確定にし、成功したbatchだけcatalogから除去する。
中断・部分失敗やinventory確認記録のない旧catalogでは確認済み件数と装わず、通常の世代一覧検証で再確定する。追加先無効化は件数を消さない。
最終保存は検証済み世代の元のcapture時刻で、最終転送時刻と混同しない。保持設定・バックアップ形式の変更はない。

backup設定schema 3は`local_retention`と`destinations`配列を持つ。各保存先は`location`判別unionと`credential_ref`を持ち、ローカルは`{kind:"local-directory",path}`、Googleは`{kind:"google-drive",connection_id,root_folder_id,display_name}`である。
schema 2の`path`/`credential`、旧単一`additional`、status、転送台帳、初期化途中のintentは1 transactionで移行し、順序、有効状態、保持値、repository ID・資格情報参照・運用履歴を維持する。未知schema/locationは拒否する。
設定の移行だけでNote、content_epoch、バックアップ形式を変更せず、repositoryを再初期化しない。設定のない新規・復旧Workspaceのstatus/config取得は書き込みを行わない。
初期化成功後に資格情報保存が失敗してもintentを保持し、再試行時に同じrepositoryを検証して登録する。

解除はrepository自体を削除しない。別PCでの復旧に備えパスワードを別途保管する必要がある。
同じ物理媒体にある2つのrepositoryは、その媒体の故障に対する二重化ではない。

### 6.1 Google Drive（実験的）

同梱rclone 1.75.1の`serve restic --stdio`をResticの転送路として使う。ローカルの正常世代を
独立した鍵のrepositoryへ`restic copy`する。repositoryのfile copy、sync、mount、常駐daemonは使わない。
repositoryはマイドライブのMemoka専用新規folderに限定し、Shared Drive、service account、任意backendは受け付けない。
表示名で場所を特定せず、作成応答で得たfolder IDと検証済みrepository IDを保持する。

Google接続はOSユーザー単位でWorkspace外へ保存し、複数保存先から共有できる。OAuth tokenとResticパスワードは別の秘密である。
公式AppImageとCLIは同じMemoka用Desktop OAuth clientを組み込む。client未設定のsource buildではGoogle接続だけを無効化する。
OSブラウザ、loopback callback、state、PKCE S256を用い、
要求scopeは`drive.file`のみ。これは専用folderだけのOAuth権限ではなく、アプリが扱えるfileへの権限である。
再認証は別の暗号化configで行い、同じclient/account、scope、登録root・repository IDの検証後に切り替える。

登録はWorkspace ID・destination ID・nonce・実folder ID・repository ID・phaseを持つintentで再開する。
新規intentは`placement`へ親folder ID・表示名・自動選択フラグと、Drive `files.generateIds`で予約した子folder IDを保持する。
親と子の作成予定ID・nonceはそれぞれPOST前にWorkspace外のowner-only状態へ永続化する。応答喪失時は同じIDで照合・再試行し、409ならGETでID・親・appPropertiesを再照合する。別IDで重複作成しない。
`placement`のない旧intentは従来のマイドライブ直下を維持し、nonce照合で再開する。旧方式の応答喪失で未発見/複数候補なら再作成しない。
init後の鍵保存失敗は同じパスワードで再試行する。
既存root消失、権限不足、repository mismatchを自動initで隠さない。同一Workspaceの同一repository二重登録を拒否する。

新規保存先の既定配置は`Memoka/Backup-<Workspace ID>-<destination ID>`で、destination IDは保存先の新規登録ごとに発行するUUIDv7である。
旧`MemokaBackup-<Workspace ID>-<destination ID>`を含む登録済みroot・binding・repository IDは変更せず、移動も行わない。
親`Memoka`は`appProperties.memoka_container=1`で同定する通常folderで、repository用markerは付けない。同名だけのfolderを流用しない。
同じaccount/clientの自動親作成はOSユーザー内のleaseで直列化し、marked folderが複数なら明示選択を要求する。親の削除・移動・統合は行わない。
Google接続metadataのoptional `backup_parent`へ親ID・表示名・automaticを記憶する。旧metadataの未設定は自動`Memoka`と解釈する。
追加画面のGoogle Desktop Pickerで利用者作成の既存folderも選択できる。同じDesktop client・drive.file・state・PKCE・loopbackを使い、OAuth codeと選択IDはnative内で処理する。
同じaccount、書き込み可能な通常folderを確認後だけ親設定と暗号化tokenを更新し、拒否・取消・期限切れ・通信失敗は従前の設定と資格情報を維持する。
My Drive root、Shared Drive、shortcut、trash、既存repositoryと識別可能な子孫を拒否する。drive.fileで未許可の祖先は取得できないため、全祖先走査を保証せず、scopeを拡大しない。
選択機能には同じCloud projectでGoogle Picker APIを有効にする。選択・自動へのresetは今後の新規登録だけに適用し、途中intentの親は固定する。
記憶した親が消失・権限喪失した場合は自動で別の親を作らず、再選択を求める。親は取消・保存先解除・保持整理の削除対象にしない。
実folderの`appProperties`にもWorkspace ID・destination IDを記録する。表示名が変わってもfolder IDで同定する。
Workspace IDはデータのidentityであり端末のidentityではない。復旧はWorkspace/Note/Section IDを維持する一方、追加保存先の設定を引き継がない。
復旧先からの新規登録は新しいdestination IDとfolderを作り、元PCのbackup folderをwriterとして再利用しない。
端末同期は未実装であるが、将来もbackup destination設定とOSユーザー単位のGoogle接続・bindingは同期の対象外とする。

通常のbackup/copy/verify/maintainとロック復旧では、Workspace外のGoogle接続registryのbindingに対し、Workspace ID・destination ID・folder ID・repository ID・資格情報参照の一致を確認する。
さらに既存のroot照合でDriveの`appProperties`を照合する。未登録・不一致は明示エラーにし、同じaccount/folder/passwordだけでは既存rootをwriterへ昇格できない。
別PCの単独復旧用接続にはbindingを要求しないが、その経路はlist/check/restoreのみであり、copy/maintain/unlockへ流用しない。
この分離は通常の登録・復旧に対する保証で、OSユーザーの接続registry・資格情報まで複製した端末の識別や、旧版/外部Resticに対する分散writer lockではない。
設定・資格情報を複製して同じrootへ書き込む運用は非対応とし、Resticのrepository lock自体は引き続き維持する。

通常Google転送は最大16世代を1回のRestic `copy`へ渡す。複数commandの単なる連続実行ではなく、同じ接続・lock・index読み込みを共有したbatch転送である。
1転送batch、1世代の検証、または整理単位に最長1時間を割り当て、1単位ごとに保存先を巡回する。件数を満たすための待ち時間は設けない。
Restic境界は1〜16個の完全長snapshot IDだけを受け付ける。空配列を「全世代copy」として渡さず、別Workspaceや未選択snapshotへ対象を広げない。
同期的なlocal/CLI経路は従来どおり1世代ごとのcopy＋検証を維持する。
新規編集がなくても約1分ごとのscheduler tickでpendingを再評価する。新しい世代の作成は実行中のcopyを中断しない。
自動転送はuploadを先に完了し、同じworkerの次の独立した処理単位で検証を開始する。検証には無操作待ち・次の60秒tick待ちを挟まない。
検証待ち台帳のlocal-only probeをupload済みreceiptと分離し、receiptがcurrentでも検証待ちならworkerを起動できる。台帳は永続化し、再起動直後のschedulerでも再開する。
通常workerはuploadとverifyを許可し、departure中は未開始のverifyを開始しない。idleまたは明示要求だけがmaintainを許可する。
保持整理は30秒以上キー入力・クリック・スクロールがなく、検索索引更新がidleで、先行するcapture等がないtickで開始する。
明示的な「今すぐ転送」はこの無操作待ちによらず検証・整理も再試行できる。障害時のbackoffは検証にも引き続き適用する。
複数先に転送できるデータがある場合、後続の検証・整理よりuploadを優先する。
copy前には接続先identity、source repository ID、batch内の全source descriptorとfile集合を確認するが、毎回のremote全世代一覧・検証は行わない。
全sourceの確認が終わるまでbatchの送信を始めない。batchのgeneration ID列を`TransferLedger.active_batch`へ送信前に永続化し、失敗・中断後は新しいcaptureより先に再試行する。
旧台帳の`active_batch`未設定は空とし、旧`active_generation_id`も優先する。local保持整理で失われたpendingは期限切れへ移し、残ったsourceで再開する。
成功したcopyは期待descriptorを`TransferLedger.awaiting_verification`に永続化し、転送待ちから外す。`delivered`・保護済み日時は進めない。
copy command全体の成功後、batch全体の期待descriptor・台帳・件数を同じSQLite transactionで更新する。未検証なので保護済み日時は維持する。
失敗・中断・成功応答喪失時はbatch全体をpendingのまま保ち、人間向けstdoutから一部成功を推測しない。再実行ではResticの冪等copyにより部分転送済みsnapshotを重複させない。
検証完了時も世代ごとの台帳・件数・保護済み日時を同じSQLite transactionで更新し、途中終了やDB書込み失敗で不整合にしない。
進捗のoptional `batch_generations`はまとめ転送対象数を示す（旧stateは0）。複数世代を単一の「処理中世代」として表示せず、完了数はbatchの成功永続化後にまとめて進める。通信量のlive表示は継続する。
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
別jobへ持ち越さず、後続の転送後検証と実削除前は最新のIDを再照合する。ID取得の`cat config`は`--no-lock`で復号して読み、
確認のたびにDriveへlock fileを書き込まない。後述のlock metadata診断もlockを取得しないが、snapshot/fileの読み取り、copy、forget、pruneのRestic lockは維持する。
一時障害は指数backoff（最大1時間に0〜30秒のjitter）を持ち、認証失効・鍵取得不能・権限/容量不足・repository不一致や不明なlayoutは明示操作まで保留する。
ネットワーク待ち中はCore mutexを持たず、copyのsource-reader leaseはCapture追加・履歴readを許可し、sourceのforget/pruneだけを除外する。
無効化はGoogle workerへ中断も要求する。再接続、明示転送、中断、既存パスワード再登録、無効化、解除は独立した操作である。

接続解除はこの端末の資格情報だけを除き、Googleのproject認可をrevokeしない。利用先がある場合は一覧を示し、
先に各保存先を解除するか、共有接続の全利用先を停止すると明示確認する。後者は非秘密の接続/保存先参照を残し、再認証で復帰する。
Google上のfolderと世代は削除しない。status/設定の通常表示はmetadataだけで、Googleや資格情報ストアへ問い合わせない。

ユーザーによる実Driveの接続・保存先登録と一部世代の転送は確認済みである。
**token更新・認可取消後の再アクセス・別OSプロファイル復旧は未検証であり、正式提供可とは判定しない。**
OAuth client変更で以前のbackupにアクセスできる保証はなく、scopeの自動拡大や空repositoryへの置換は行わない。
client設定・配布条件は[Platform、配布、Security](platform-release-and-security.md#72-oauth-clientの設定と配布)、
正式提供へ移行するための条件は[検証](validation.md#google-driveの追加検証)に集約する。
実験的機能としての同梱は、長期利用・別PC復旧の検証完了を意味しない。

### 6.2 残存ロックの確認・復旧

異常終了等で残ったrepository lockは、通常のrepository操作がResticのlock取得失敗（exit 11 / `REPOSITORY_LOCKED`）になった場合に自動復旧する。
対象はID照合済みのWorkspace local repositoryまたは登録済み追加保存先で、GoogleはこのOSユーザーのwriter bindingも必須とする。
path/passwordを指定しただけの単独list/check/restore用handle、初期化前や資格情報の再登録検証用handleへ自動解除権限を与えない。
独立した定期lock scanは行わず、正常な処理・status pollで追加のRestic起動や保存先アクセスを行わない。

失敗した子processとtransportの回収完了後、同じlease・キャンセル・処理期限の下でrepository IDをfresh照合し、通常の`restic unlock`で失効lockだけを解除する。
解除後のIDもfresh照合してから、元のcommandを一度だけ再試行する。copyはtyped source/targetのうち権限のあるrepositoryだけを対象にし、argvの任意pathから解除先を推測しない。
一時出力fileを持つdumpは、新規作成した出力を先頭へ戻して再試行し、失敗時のbytesへ追記しない。元のoutput pathを新規作成する契約は維持する。
対象commandはbackup/snapshots/dump/ls/copy/forget/prune/checkに限定し、unlockやmetadata診断へ再帰的に適用しない。
exit 11以外の不完全書き込み・通信・認証・キャンセル・期限切れを再実行しない。稼働中lockはResticの失効判定と再試行command自身のlock取得に委ね、forceや無限retryを使わない。
source-reader leaseによるcapture/readの並行性は維持し、失効lockのみの解除のために全Workspaceを停止しない。
再試行も失敗した場合は従来のerror/backoffを維持する。unlock成功だけで世代数・台帳・保護日時を進めず、元の処理の検証・永続化成功によってのみ状態を更新する。
進捗stageは`lock-recovery`（「失効ロックの自動確認・解除」）、commandは`unlock`として記録し、再試行時には元のstageへ戻す。解除回数を転送済み世代数と混同しない。
保持整理が再開すれば既存の検証済み削除計画に従う。dry-runでは失効lockの解除はあり得るがsnapshot/packの削除はしない。

GUIの保存先詳細「進捗」とCLIには明示的な確認・復旧経路も残す。手動操作はNativeServiceの排他repository leaseを取得できなければ`BACKUP_BUSY`で拒否し、
capture/copy/history read/maintenanceと同時に実行しない。Googleは接続・repositoryのOS leaseと登録writer照合も行う。

確認はfresh repository ID照合、`restic list locks`と各IDの`cat lock <id> --no-lock`だけを実行する。
応答は`schema_version:3`、repository ID、`unlock_attempted`、`locks`配列で、lock ID・更新日時・hostname・PID・exclusiveだけをallowlist出力する。
入力するIDの形式・件数と出力fieldを検査し、生の子process出力やusername等を公開しない。
GUIは端末/PID、`YYYY/MM/DD HH:mm:ss (ago)`のロック更新日時、共有/排他、短縮IDを表示する。表示だけで解除しない。

手動復旧はGUIの確認操作またはCLIの明示unlock要求を経て、通常の`restic unlock`を実行する。自動・手動とも`--remove-all`や任意optionを渡す経路は提供しない。
失効判定は固定Resticに委譲し、同一hostnameで終了済みのPID、または30分超heartbeatが更新されないlockだけが解除対象となる。
通常のheartbeatは約5分ごとのため、処理の全経過時間で失効判定しない。hostname変更やPID再利用で直ちに解除されない場合もあり、残存lockを一覧へ返す。
手動復旧後は再度fresh IDとlock一覧を確認し、成功でもcopy/verify済みとは扱わず、保存済み世代・転送台帳・保護済み日時を変更しない。
lockがなくなった場合だけ当該保存先の`REPOSITORY_LOCKED`エラーを解除し、他のエラーがなければbackoffを解除して通常の再試行を可能にする。
その他のエラー、残存lock、identity不一致を隠さない。ロック解除自体はsnapshot削除・保持整理を実行しない。

失効判定の根拠は[Restic 0.19.1のlock実装](https://github.com/restic/restic/blob/v0.19.1/internal/restic/lock.go)、
stale-onlyの解除は[unlock実装](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_unlock.go)による。

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

Googleはbatch copyと1世代ごとの検証とは別の整理単位を巡回する。整理前には専用root内の元のDrive metadataで
同名object・shortcut・Google Docs・不明なrepository layoutを検査し、不整合があれば停止する。
`drive_use_trash=true`を明示し、削除objectはDriveのゴミ箱へ送る。repository整理成功はGoogleの空き容量増加と同義ではない。
`cleanup`、`emptyTrash`、自動dedupe、未確認の完全削除や強制unlockを実装しない。

## 8. 終了・切替・キャンセル

OS close、`:quit`、`:q`、`:qa`は共通shutdown処理を使う。
確定Core保存を先にflushし、バックグラウンド処理の安全な中断・子process回収後に終了する。
終了のためのlocal captureや転送を開始せず、転送/検証/保持整理の成功は待たない。
既存の未包含epoch、pending/awaiting_verification台帳と最後の正常世代を残し、次回起動後に再開する。
終了後は常駐処理を持たない。端末に保存済みでも外部には未保護の場合があり、終了ごとの世代作成は保証しない。
Core保存失敗は終了を阻止する。停止失敗も独立したstopping-errorとし、子processを残した強制続行を提供しない。
停止失敗から編集へ戻る場合も停止を再確認してからbackground admissionを再開する。

同じNativeServiceで確認済みのbackup cycleについて、process-local receiptでno-opを早期判定する。
Core保存barrier自体は省かず、SQLite read transactionで現在のcontent_epoch、保存済みepoch、保存先設定、転送台帳を照合する。
公開される待ち件数だけでは省略しない。保持中の全世代が、同じrepository IDの台帳でdeliveredまたはDriveのawaiting_verificationに含まれ、pendingが空であることを要する。
有効なlocal保存先とlocal履歴はconfigのhash、snapshot名・size・mtimeを確認し、欠落・差替え・symlink等があれば通常の検証へ戻す。
receiptが成立する場合は全Noteのvalidate、Restic起動・世代一覧取得、copyの再起動を省く。保存状態や保護済み日時を書き換えない。
receiptは永続化せず、再起動時は通常確認する。編集、保存先の追加/変更、転送失敗や台帳不一致、明示check/maintain等は通常経路へ戻す。
snapshotを変更しない正常なidle保持確認はreceiptを捨てない。これは完全性検査ではなく、明示checkや変更時の検証を代替しない。
通常のcloud tickはreceiptが成立し、かつ今実行できる検証待ちもなければ新しいworkerを起動しない。
転送済み・検証待ちはreceiptだけでskipせず、通常workerで検証を続ける。idle/manualの保持整理は独立して実行する。
通常のbackup no-op判定だけでは開始済みworkerを中断しない。quitはこの判定とは別に中断し、切替・更新は完了待ちを継続する。

終了・Workspace切替・Updaterは同じ進捗overlayで、保存中、履歴作成・転送中、編集復帰中、中断待ち、実行中、失敗を区別する。
再試行、操作のキャンセル、バックアップだけを中断して続行する選択肢を用意する。
省略はCore保存成功後に限り、正本保存の失敗を無視して終了する選択肢は提供しない。
「切替/更新を取り消す」（Esc/Ctrl-cを含む）はdeparture待機だけを解除し、開始済みのcapture/copy/検証を継続する。
進捗pollと未開始の最終capture待機を解除し、転送のcancel token・失敗状態・保護済み日時には触れない。
nativeのdeparture待機は操作IDに所属させ、取消済み操作の遅延応答や解除が新しいdepartureへ作用しないようにする。
CLI単独実行の転送待機はGUIのdepartureに所属せず、GUIの操作取消では解除しない。
通常quitと切替/更新の「バックアップを中断して続行」は処理全体に属するtokenで後続phaseも停止し、子processの回収後に完了する。
LinuxではRestic本体だけへSIGINTを送り、rcloneを生かしたまま最大20秒のlock解除猶予を与える。
Windowsの非console childでは自然終了を同じ上限まで待つ。正常解除を保証するものではない。
猶予を過ぎたらprocess group / Job Objectの子孫まで強制終了・回収し、leaseを解放する。

切替・更新の追加先待機には時間上限を設けず、30秒でtimeoutにしない。通常の1時間処理上限と接続・無応答timeoutは別に維持する。
切替・更新準備の開始時にnative workerを転送優先・後続検証/整理保留へ切り替え、進行中の単位は自然終了を待つ。
未開始の検証・整理は検証台帳から再開できる。切替・更新の操作取消で通常のidle検証を再び許可する。
未検証は保護済みではなく、転送後の検証エラーだけで切替・更新を阻止しない。GUIにこの違いを表示する。
中断ではResticとrcloneの子孫まで終了し、lease解放を待つ。キャンセル後に遅れて届いたtickは再開操作まで拒否する。
意図したCANCELLEDは失敗回数へ加算せず、次回再開用の通信backoffを付けない。過去のCANCELLEDに残るbackoffも無視するが、認証/identity等の恒久障害は無視しない。

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
memoka-cli backup locks --workspace <dir> --destination <destination-id>
memoka-cli backup unlock --workspace <dir> --destination <destination-id>
memoka-cli backup check --repository <repo-dir> --insecure-no-password --full
memoka-cli backup restore --repository <repo-dir> --generation <generation-id> --target <empty-data-area> --insecure-no-password
```

GUI所有中の運用commandもownerへ依頼し、同じschedulerとrepository leaseを使う。
`backup status`・`run`・`copy`・`maintain`のJSON応答はtyped locationに対応する`schema_version: 3`である。
statusは`config.destinations`配列と`status.destinations`のID別state、run/copy/maintainは保存先ID別の結果を返す。
`backup locks/unlock`もschema 3でlock情報を返す。`--destination`省略時はlocal履歴、指定時は登録済み追加先のIDであり、任意のrepository/connection/folder指定や強制解除は受け付けない。
owner GUIがある場合も保存barrier/captureを起動せず、owner内の同じ排他leaseで処理する。
GUIの`:backup-status`は廃止し、`:backup-settings`へ統合する。CLIの`backup status`は維持する。
repository単独でlist/check/restoreでき、現在DBが壊れていても復旧できる。
追加先では`--insecure-no-password`の代わりに`--password-stdin`または対話入力を使う。
パスワード文字列を引数で渡すoptionはない。誤パスワードから空パスワードへfallbackしない。

復旧は別の空directoryへのみ行う。source/repository内、非空target、既存Workspaceへの上書きは拒否する。
allowlistだけをprivate stagingへ取り出し、DB integrity、Yjs replay、Namespace、H6、添付hashを検査し、
完成してから公開する。IDとdocument revisionは維持する。
復旧先のlocal repository・追加保存先設定、転送queue、accepted-state、lock、local UI、検索index等の運用派生stateはリセットする。
次回GUI起動時に新しいローカル履歴を作る。GUIに`:restore`や一括export commandは設けない。

### 11.1 Google接続とrepository単独復旧

```bash
memoka-cli cloud connect google-drive --name recovery
memoka-cli cloud list --format json
memoka-cli cloud reconnect --connection <id>
memoka-cli cloud disconnect --connection <id>
memoka-cli cloud disconnect --connection <id> --stop-destinations
memoka-cli backup list --connection <id> --drive-folder-id <folder-id> --password-stdin
memoka-cli backup check --connection <id> --drive-folder-id <folder-id> --password-stdin --full
memoka-cli backup restore --connection <id> --drive-folder-id <folder-id> --generation <generation-id> --target <empty-data-area> --password-stdin
```

公式CLIは組み込みclientを使用する。元接続が異なるclientを使う場合やsource buildでは、同じclient JSONを`--client-file <absolute-path>`で指定する。
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

## 端末間同期との境界

同期のjournal・inbox・checkpointはローカル保存の耐久性に従うが、終了時はネットワークの完了を待たない。
未取得添付・未生成のローカルHelpを含む新しいcaptureは「同期データの取得待ち」とし、取得後に再開する。
未取得を`known_missing`として正常世代へ取り込まない。既存の正常世代はその間も保持する。
復旧先から同期の認可・招待・配送・古いReplica ID・編集receiptを除き、新しいReplicaとして同期無効で開く。
[端末間同期](device-synchronization.md)の初回参加は新しい保存先への複製だけを許可し、復旧済みWorkspaceの合流は行わない。
