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

ローカル履歴を残したまま、追加先を1つ設定できる。
`:backup-settings`でWorkspace外の親directoryを選び、その下の専用`memoka-<workspace-id>`へ保存する。
Workspaceとの相互包含、既存の不明repository、空パスワードを拒否する。

追加先は独立した暗号鍵でRestic initし、ローカル世代をsnapshot copyする。
ローカルrepositoryのfile copyとパスワード変更で代用しない。
パスワードはOS資格情報ストアへ保存し、必要なRestic childだけの環境変数へ渡す。
argv、設定file、通常log、Command-line履歴には入れない。既存パスワードの再登録UIを持つ。

追加先がoffline、鍵が取得不能、容量不足でも編集とローカル履歴は継続する。
転送は新しいcaptureから試み、GUIの1回の転送試行には時間上限を設ける。
同じgenerationを重複作成せず、元のcapture時刻を維持する。
転送待ち、転送機会の期限切れ、追加先で保護済みのcapture時刻を区別して表示する。
追加先を変更したとき、以前の保存先への転送済み判定を流用しない。

解除はrepository自体を削除しない。別PCでの復旧に備えパスワードを別途保管する必要がある。
同じ物理媒体にある2つのrepositoryは、その媒体の故障に対する二重化ではない。

## 7. 保持と容量回収

正常世代へ「直近48世代 OR 日次30世代 OR 月次12世代」を各repositoryで独立適用する。
Resticのcalendar policyを使い、Workspaceごとに1つの集合として扱う。
hostname、capture一時path、generation tagごとに保持集合を分割しない。

dry-runのkeep/remove集合を確認済みsnapshot集合と照合し、最新正常世代が残ることを検証してから、
明示したsnapshot IDだけをforgetする。追加先にしかない世代を、localから消えたという理由では削除しない。
copy中はsource repositoryのleaseを保持し、retention/pruneと競合させない。

forgetとpruneは別処理である。pruneは30秒以上入力操作がないidle時に開始し、各repositoryで24時間に1回まで行う。
`backup maintain`でも実行でき、`--dry-run`では変更しない。
capture/copy失敗の直後に成功後cleanupとして世代を減らさない。
prune失敗はaccepted backupを未作成へ戻さず、maintenance errorとして表示する。

## 8. 終了・切替・キャンセル

OS close、`:quit`、`:q`、`:qa`は共通shutdown処理を使う。
確定Core保存を先にflushし、未包含変更のローカル履歴とboundedな追加先転送を待つ。

終了・Workspace切替・Updaterは同じ進捗overlayで、保存中、履歴作成・転送中、中断待ち、実行中、失敗を区別する。
再試行、操作のキャンセル、バックアップだけを中断して続行する選択肢を用意する。
省略はCore保存成功後に限り、正本保存の失敗を無視して終了する選択肢は提供しない。
キャンセルは処理全体に属するtokenで後続phaseも停止し、Restic childをkill/reapしてから完了する。

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
repository単独でlist/check/restoreでき、現在DBが壊れていても復旧できる。
追加先では`--insecure-no-password`の代わりに`--password-stdin`または対話入力を使う。
パスワード文字列を引数で渡すoptionはない。誤パスワードから空パスワードへfallbackしない。

復旧は別の空directoryへのみ行う。source/repository内、非空target、既存Workspaceへの上書きは拒否する。
allowlistだけをprivate stagingへ取り出し、DB integrity、Yjs replay、Namespace、H6、添付hashを検査し、
完成してから公開する。IDとdocument revisionは維持する。
復旧先のlocal repository設定、転送queue、accepted-state、lock、local UI、検索index等の運用派生stateはリセットする。
次回GUI起動時に新しいローカル履歴を作る。GUIに`:restore`や一括export commandは設けない。

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
