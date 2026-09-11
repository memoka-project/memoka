# 端末間同期

[仕様書へ戻る](../specification.md)

## 1. 利用可能な範囲

同じ利用者の端末をLAN・VPN内で直接接続し、Workspaceを開いている間に自動同期する。
同期は既定で無効であり、明示的な有効化・参加操作までは待受けしない。
オフライン編集をローカルへ保存し、再接続・再起動時に未送信・未反映の変更を再開する。
終了時はローカル保存を待ち、相手端末への配送・反映・添付取得の完了は待たない。

対象はNote、Section、Block、Tree、Trash、添付metadataと実ファイルである。
設定、Window配置、選択・折畳み、Undo、検索索引、バックアップ世代・保存先・資格情報は共有しない。
管理HelpはNote ID・配置・役割を共有する。有効化前に元端末で一つ作成し、参加端末は同じNote IDで
同梱Markdownから本文を生成する。Helpの手動編集とタイトル変更も端末内に限定する。

保存schemaはNoteDoc 7、WorkspaceMetadataDoc 4、SQLite 7である。既存Workspaceは検証付きで移行する。
初回参加は新しい空の保存先への複製だけとし、既存コピーやバックアップ復旧先との合流は拒否する。
旧schemaとの混在同期も拒否する。[検証の記録](../device-synchronization-implementation.md)に実行環境と未検証の範囲を記載する。

## 2. 独立した共有要素

NoteDoc 7のモデルは、次のYjs/Yrsのroot共有型から成る。

| 共有型                      | 内容                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| `meta`                      | `note_id`、`schema_version = 7`、`content_layout = entity-map`、作成・更新日時 |
| `entities`                  | UUIDv7をkeyとする要素の初期型とTableセルの列ID                                 |
| `content`                   | 要素IDごとの固定Map。属性のMapと本文・装飾・inline atomのXML fragmentを保持    |
| `attrs:<id>`、`inline:<id>` | 決定的IDを持つ空セル等の並行実体化に使う共有型                                 |
| `placements`                | 操作ID、Replica ID、論理counter、要素ID、親ID、領域、兄弟位置                  |
| `deletions`                 | 削除操作ID、Replica ID、観測した削除対象ID集合                                 |
| `restorations`              | 復元操作ID、Replica ID、取り消す削除操作IDと対象ID集合                         |

配置操作は本文fragmentを削除・複製しない。Section、Block、ListItemの本文は配置先と独立して同じ共有型に残る。
通常要素の内容は固定の`content` Map内に置き、大量のroot共有型によるYjs符号化の走査を避ける。
並行実体化する要素だけを`contentRoot: true`として名前で対応付け、内容Mapの競合による取りこぼしを防ぐ。
初期の検証snapshotの名前付きroot形式も読み出せるが、未知のcontent layoutは拒否する。
copy APIはsubtreeの各要素へ新しいIDを割り当てる。BodyChunkはEditorが生成する表示単位で、共有要素の親にしない。
Tableの行・列を独立したIDで保持し、セルは行と列のIDで対応付ける。並行追加による空の交点は表示時に補い、
書き込む際に同じ交点から決まるIDで実体化する。既存セルのIDと本文は維持する。

## 3. 統合と保護

本文はYjsの文字・装飾の差分で統合する。配置はcounter、Replica ID、操作IDの順で比較し、
親とその親の下での兄弟位置を同じ操作に保持する。兄弟位置の衝突はIDのbytewise比較で決定する。
循環は親の変更履歴から決定的に解消する。[Mutable Tree Hierarchy](https://madebyevan.com/algos/crdt-mutable-tree-hierarchy/)を基礎とする。
H6超過は最も近い制限内の祖先へ表示を補正し、補正されたIDを返す。受信・読出しによる補正は共有文書へ書き戻さない。

削除は本文を消去せず、削除操作を残す。復元は指定した観測済みの削除だけを取り消す。
並行して発行された別の削除は残る。削除された親へ追加された子、削除された列のセル、型変更で表示できない内容は
復旧対象として返す。`:recovery`は現在のNoteの保護対象を中央modalに50件ずつ表示する。
観測済み削除の取り消し、隠れた子を表示できる親の型への復旧、表示できないinline内容の新しい段落への複製を行う。
複製は新IDを使って装飾・linkを保持し、元の内容を消さない。型の復旧は確認後に別の型変更があれば再読出しを要求する。
復旧操作は既存owner・保存queueを通り、失敗時は文書とmetadataをrollbackする。背景EditorのDOMとfocusは維持する。

不正ID、未知schema、未知inline型・mark、依存が欠けたupdate、列対応の不正は拒否する。
受信updateは候補文書で検証した後だけlive文書へ適用する。拒否した内容で元文書を変更しない。
単一updateとIME待機queueの上限は16 MiB、要素数は200,000、構造操作は合計1,000,000である。
この境界は永続inboxや分割転送の代わりではない。

## 4. Editorと読出し

adapterは要素ごとの本文fragmentへ差分を書き込み、入れ子XML全体を共同編集の正本にしない。
文字編集では対象要素だけを書き込み、受信表示でも対象要素だけを置換する。
構造変更は構造要素の境界で表示へ適用し、open Sliceの結合によるIDの重複を避ける。
構造変更時のprojectionと索引は再生成する。本文の通常入力では要素全体やWorkspace全体を再走査しない。
10 MiB／10万行の通常Editor試験で貼付け、入力、検索、再起動を検証する。

カーソルは要素IDとYjs相対位置で追従する。複数viewのIMEが終わるまで対象Noteの受信適用を待機し、
確定したローカル入力の後で反映する。受信表示はfocusを要求しない。Undoはローカル本文操作と構造の逆操作を扱い、
要素の作成を戻す場合も共有要素を物理削除しない。Undo履歴はsession-localでありsnapshotへ含めない。
VimのchangeからEscまでを一つの履歴にまとめ、複数Windowでも同じNoteの内容を共有する。
Coreの一括編集とCLI編集は一時的なprojectionで計画し、検証した後に安定IDごとの差分だけを正本へ保存する。
受信内容の保存で更新日時を受信端末の時計へ置き換えない。
表示中のSectionが削除された場合は近い表示可能な祖先へ切り替えて通知する。
同じEditorのDOM・focus・scrollを維持し、後の復元では元のSectionへ自動で戻さない。
H6補正で新たに表示位置を変更したSectionの件数を通知する。表示投影とEditorのID補正は共有内容へ書き戻さない。

Rustの共通Note readerはschema 7の本文、構造、Tableの空交点、保護対象、H6補正を解釈する。
schema 2〜6の読出し経路も維持する。schema 7のCLI編集descriptor、本文・Section編集、Note改名は同じowner・receipt経路を使う。
通常Workspaceの新規Noteはschema 7とする。旧schemaの読出しは履歴・移行用に維持する。
同期有効WorkspaceのCLI編集descriptor・requestにはコピーごとのReplica IDを要求する。
別Replicaのrequestはreceipt照合前に拒否し、整数revisionとreceiptの再送保証は同じReplica内に限定する。
Yjs snapshotをRustで読み、Rustの編集deltaをYjsで再統合する双方向のfixtureで契約を検証する。

## 5. TreeとTrash

WorkspaceMetadataDoc 4の`main_namespace`は、従来のNamespace IDとEntry IDを維持する。
Entryの固定Mapは参照先、グループ名、作成・更新日時を持ち、配置とTrashは同じNamespace内の
`placements`、`deletions`、`restorations`へ分離する。Note metadataへ配置・Trashの重複状態を保存しない。
管理HelpのNote ID、配置、役割も変換前後で一致させる。

親と兄弟順はNoteと共通の親履歴の規則で導出する。循環の補正を受信時に書き戻さない。
明示的な移動は必要な祖先の補正を固定し、統合後のTreeでも次の操作を行えるようにする。
削除操作には観測済みEntry集合と日時を持たせる。削除された親へ並行追加された子もTrashへ表示する。
独立して削除済みだった子は自身の削除操作を維持する。

復元の計画は取り消す削除操作へ束縛する。計画後に別の削除を受信しても、その削除まで取り消さない。
取り消した操作に含まれるEntryは、別の削除や削除された祖先が残る場合、Trashに残る。
GUI、CLI、検索・履歴readerは同じ投影を利用する。RustのCLI計画用XML／metadata投影そのものを保存せず、
既存のEntry共有型への差分だけをowner transactionへ渡す。

旧Workspaceの変換は独立した候補上で行い、Note metadataと全EntryのID・内容・配置・Trashを比較する。
不一致なら候補を破棄し、元の状態を変更しない。5種類のYjs fixtureとRustからの編集deltaで双方の解釈を検証する。

## 6. 永続エンジン

Rustの`ReplicationEngine`はWorkspace ownerの`ProductStore`を使う。
通信workerは既存ownerへ仕事を渡し、文書反映はGUIの保存queueと共有するpublication境界を通す。
通信方法は文書の統合判断を持たず、直接接続以外のtransportも同じjournal・inboxへ接続できる。

`ChangeBatch`はGroup・Workspace・Device・Replica ID、発行元の連番、適用済み依存、複数文書のupdate、
添付参照を持つ。署名対象の内容は配送方法と分離し、canonical JSONとdomainを分けたSHA-256 digestを
[Ed25519の既存実装](https://docs.rs/ed25519-dalek/3.0.0/ed25519_dalek/)で署名・厳密検証する。
ローカル編集と未署名journalを同じSQLite transactionへ保存し、保存後に署名する。
資格情報ストアが一時的に利用できなくても編集の保存を失わない。署名済みの原文を他端末へ転送できる。

受信は署名、Group、登録鍵、schema、サイズを検証して永続inboxへ保存する。
受信保存済みと文書反映済みのfrontierを別々に持ち、連番の欠落を越えて進めない。
順序逆転、重複、切断、再起動を許容する。反映は依存が揃ったbatchを候補状態で検証し、
全対象文書、添付metadata、反映済みreceiptを一つのowner transactionで保存する。
検証中に別のローカル保存が入った場合はrevision競合として再準備する。受信日時をNote更新日時に使わない。
既存の共有要素、内容Map、配置・削除履歴を物理削除・差替えするupdateは拒否し、破損updateを隔離する。

checkpointには整合した共有文書の全状態と包含するfrontierを持たせ、受信側の未送信編集へCRDTとして統合する。
journalのpayloadを集約しても内容hashとreceiptを保持し、構造履歴・delete setをバックアップ世代数で捨てない。
複数のcheckpointの包含範囲が異なる場合は、相手に不足する範囲を実際に含むものを選ぶ。
削除だけのupdateも連番で配送するため、State Vector一致を完了判定には使わない。

添付は256 KiB以下のchunkで転送し、ファイルのfsync後に受信位置を保存する。
再起動時は最後に永続化した位置へ戻り、重複chunkの内容一致を確認する。
サイズと最終SHA-256が一致してからCASへ公開する。破損内容は隔離し、再試行は新しい受信ファイルで行う。
本文と添付metadataは実ファイルより先に反映でき、取得待ち件数・容量を状態へ返す。

現行上限はbatch 64 MiB、checkpoint 256 MiB、inbox 1 GiB・4096 batch、添付staging 1 GiBである。
一つの添付の上限128 MiBは既存の取込み経路と共通とし、破損した添付の隔離ファイルは直近4件を保持する。
転送・署名は一回の処理量を制限し、一時停止中もローカルjournalの保存を続ける。
署名・受信検証・checkpointの生成・添付hash検証はバックグラウンドのworkerで行う。
整合した読出し専用snapshotで文書反映を準備し、ownerで設定・鍵・revisionを再確認してcommitする。
GUIはcommit済みの配送ticketを受け取り、画面反映後にackする。応答消失時は同じticketを再読出しする。
IME開始がSQL commitの後に重なっても確定入力を保護し、画面へ反映できるまで対象Noteの保存を順序付ける。
WorkspaceだけのTrash変更も対象Noteを含めて待機する。並行入力は削除済みNote内に保存して復元可能にする。
添付の未取得・失敗は本文のplaceholderと同期詳細へ表示し、詳細から取得を再試行できる。

## 7. 認証と直接通信

認可は署名付きの因果グラフで保持し、各端末が登録・解除を発行できる。
最初に確認したgenesisのhashを固定し、Workspace IDの一致だけで参加を認めない。
Aが登録したBから登録されたCは、署名の連鎖をAへ提示して認証できる。発行元と直接接続する必要はない。
Group、Device、ReplicaのIDと公開鍵を別に検証し、登録済みID・鍵を再利用しない。

解除は取り消せない。解除が観測した過去の登録は、登録元の解除によって連鎖的に取り消さない。
解除と因果関係のない並行登録は承認未成立として除外し、新しい鍵で有効な端末から再承認する。
解除済み鍵が過去のgraphや小さいclockを使って後から署名しても、この制限を回避できない。
相互の並行解除は両方を解除し、到着順で勝者を選ばない。端末が過去に確認した有効な解除は後の統合でも維持する。
解除の伝播前に受け入れた変更や、既に渡したデータの遠隔消去は保証しない。

秘密鍵は同期専用のOS資格情報ストアに保存する。本文DB、journal、認可履歴、接続情報へ秘密鍵を含めない。
招待は公開鍵・直接IPアドレス・Group・期限・一回限りのtokenを持ち、招待側の鍵で署名する。
有効期限は10分。DBにはtokenのhashだけを保存する。最初の参加要求を候補端末の署名と鍵へ固定し、
別の候補による再利用を拒否する。候補が表示されたことを参加承認として扱わず、確認した鍵に一致する承認だけを保存する。
承認と認可履歴は同一transactionで保存し、同じ要求の再送・再起動でも重複登録しない。
接続先の変更は登録済み公開鍵との一致を要求する。復旧先は認可・招待・配送状態を消し、新しいReplicaで別グループを作る。

iroh 1.2.0の最小構成を利用し、relay、address lookup、portmapper、HTTP probeを無効にする。
標準IP transportは接続先が通知するNAT候補を探索するため使わず、手動宛先と受信元への返信だけを許す
UDP transportへirohのQUICを接続する。暗号化・鍵認証はirohが担当し、独自暗号を実装しない。
不安定なtransport APIを利用するため依存versionを固定し、更新時も実パケットの宛先を検証する。
Envelopeと署名対象の内容を分け、Frameの種別・長さを本文の読込み前に検証する。
制御・文書・添付のstream優先度とQUIC受信windowを分け、巨大転送が小さな制御交換を塞がないようにする。

有効化済みWorkspaceでは自動接続・再送を行い、一時停止・Workspace切替・終了で待受けを停止する。
接続は同時8件まで、失敗時は最大30秒の間隔で再試行する。`:sync`で再接続を要求できる。
解除前に反映した変更は、有効な別端末が署名するcheckpointに含めて未接続端末へ引き継ぐ。
解除済み発行元の変更やcheckpointを新規配送することはしない。
`pnpm sync-direct-network-gate`はLinuxのstraceで外部探索・relay・portmapperへの送信がないことを確認する。
ローカル経路の調査で行うUDP connectは送信を伴わず、そのsocketへの後続書込みがないことも確認する。
Windowsでの実パケット検証と、LAN/VPNの異なる実端末間での検証は残っている。

## 8. 同期とバックアップ

バックアップ先へ保存できることは端末間の編集同期を意味しない。
同期による削除伝播に備えるためにも、ローカル履歴と独立した追加バックアップは別に必要である。

未取得の添付・生成前のローカルHelpがある間は、新しいバックアップ世代の作成を保留し、
「同期データの取得待ち」と表示する。存在しない添付を既知の欠損として扱わず、終了を同期完了待ちにしない。

## 9. 操作と状態表示

`:sync-settings`は中央floating modalとして端末一覧、工程、最終反映日時、未送信・未反映件数と容量を表示する。
既存の絶対日時・ago表示を使う。端末追加、鍵を照合した接続情報更新、一時停止・再開、登録解除を行える。
詳細には送受信、checkpoint、添付の進捗・再試行、隔離理由、現在Noteの保護内容の復旧への入口を置く。
「接続済み」「受信保存済み」「文書反映済み」「添付取得完了」を区別し、未接続端末を同期済みと表示しない。
デバッグラインにも接続数・反映待ち・添付取得待ちを表示する。

元端末で同期を有効にし、LAN/VPNで到達できるIPアドレスとUDP portを指定して接続情報を作成する。
参加端末は`:new-workspace`または起動時のWorkspace選択画面の「別端末から受信」で接続情報・端末名・新しい保存先を入力する。
Workspaceを開いている場合も別保存先で受信し、本文受信後に旧Workspaceの保存とバックアップを待って切り替える。
元端末で候補の名前と鍵の識別情報を確認して承認した後にだけ文書を受け取る。
参加中の中断は同じ保存先から再開できる。参加用の秘密情報はOS資格情報へ置き、DBには公開の再開記録だけを残す。
文書の受信後にWorkspaceを開き、添付取得は引き続きバックグラウンドで行う。

`memoka-cli sync status --workspace <保存先> --format json`で状態を読める。
GUIがownerの場合は接続の実行状態も返す。GUIが閉じている場合は永続queue・frontierを読出し専用で返し、待受けを始めない。

## 10. 移行と復旧

旧DBは独立した候補へ変換し、移行前のSQLiteを`before-schema-v7.sqlite3`として保存する。
Note・Section・Block・Entry ID、Markdown、装飾、構造、添付hashを比較し、不一致なら元DBを変更しない。
旧Note schema 2〜6とWorkspace schema 3の履歴読出しを維持する。WALを含む移行元から整合した候補を作る。
新しい同期グループの元端末で変換し、参加端末には変換済み文書を配る。

バックアップ復旧先は同期設定・認可・招待・配送状態・古いReplica ID・編集receiptを引き継がない。
新しいReplica IDを発行して同期無効で開き、古い資格情報による自動再参加はしない。
将来の仲介・保存型サーバーは今回含めない。配送Envelopeと署名対象の内容を分け、保存型transportを追加する場合は
端末側で内容を暗号化し、HPKE等の既存実装による受信端末ごとの鍵包装を使用する。
