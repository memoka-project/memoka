# 検証

[仕様書へ戻る](../specification.md)

## 1. 原則

永続dataの欠落、IME確定の欠落/重複、Undo単位の破損、Workspace外へのpath accessはrelease blockerである。
VM/jsdom計測は回帰検出に使い、操作感とplatform integrationの最終合否はnative buildで判断する。

仕様変更を伴う実装では、該当する自動試験またはnative手動確認を同じ変更で更新する。

## 2. 文書整合性

- `doc/specification.md`を唯一の現行仕様入口とする。
- 入口から全カテゴリへ相対linkで到達できること。
- `doc/specification/`に孤立したMarkdownを置かないこと。
- local Markdown linkのtargetが存在すること。
- 固定版、Phase差分、外部private文書を理解しないと読めない記述を現行仕様に入れないこと。
- schema、command、設定既定値、Leader category、対応platformを実装と照合すること。
- `doc/help.md`のH1、Application Command、Leader categoryを実装と照合すること。
- user-visible操作を変えた場合は管理Help Note原稿も同じ変更で更新すること。

`corepack pnpm spec:check`を通常の`verify`に含める。

## 3. データモデル

自動試験で次を確認する。

- lowercase UUIDv7のvalidationと一意性
- Root Section IDとNote IDの一致
- missing IDの限定repairとinvalid/duplicate IDの拒否
- Namespaceのcycle、self-parent、orphan、deleted-parent/live-child、一意配置の検査
- jitter付きFractional Indexingの順序、衝突tie-break、局所再採番
- NoteDoc v2のBodyChunk化とv6へのmigration、v3/v4/v5からv6のmetadata-only migration（block ID/content保持）
- Detailsの作成、Summary/本文編集、開閉、再帰的開閉、折畳み本文の検索・移動、yy/dd、List内・入れ子のMarkdown/HTML round-trip
- SQLite v2/v3/v4/v5からv6への全件preflightとrollback copy
- snapshot/update log replay、revision conflict、compaction failure recovery
- 2 Windowで同じNoteDocを開いた場合のcontent共有とWindow-local state分離

## 4. EditorとVim

unit/integration試験で次を網羅する。

- Paragraph/Section titleのHard Break論理行と画面折返しの分離
- ListItem、Code、Table、atomic blockの論理行
- Normal/Insert/Replace/Visual各caretとmode遷移
- Count、motion、operator、text object、Undo/Redo、repeat
- change削除とInsert入力の1 Undo化、Undo caret復元
- `gv`の復元/交換とinvalid範囲拒否
- `whichwrap` true/falseを全block種別で統一
- 日本語fine/budoux/unicode wordとfine/budoux/native表示改行
- 日本語境界の`J`とrawな`gJ`
- Section focus/fold/depth変更とList depth変更
- 未選択List子孫を`dd`/Visual delete/yankへ含めないこと
- 複数block ListItemでHard Breakを論理行として数え、未選択の行・blockをdelete/yankへ含めないこと
- 同じItemの複数行を選択したdepth変更が1回だけ適用され、後続blockを含む表示順を保つこと
- Table Cell移動、空Cell、Visual Block、Clipboard、行列action、repeat
- Horizontal Rule、Image、Attachmentのatomic操作

## 5. IME

Windows 11 x64/WebView2/Microsoft IMEと、Ubuntu GNOME/Sway/fcitx5でnative確認する。

- Paragraph、Note title、Section title、空ListItem、Table Cellへ日本語を入力する。
- composition中の文字が表示される。
- Enter確定でtitle/body間を移動しない。
- textが欠落、重複、部分重複しない。
- composition中のEsc/Ctrl-c/EnterをIMEへ優先する。
- NormalでIMEがONのとき、OFF化後に最初のcommand keyを1回だけ実行する。
- AppImageとsourceのdevelopment buildで意味上の入力結果が一致する。

変換候補windowの位置ずれは別のplatform制約として記録し、入力dataの正しさと混同しない。

## 6. Clipboard、Markdown、Attachment

- text、block-lines、structure、section、table-cellsの内部Clipboard schema 7を往復する。
- rich MIMEが失われた場合のplain fallbackを確認する。
- HTML・Markdown・textが同時にあるClipboardをInsertの`Ctrl-Shift-v`で貼り、textだけが入る。
  Markdown記号やGFM Tableも文字のままになり、空Root titleでwhole-note importしないこと、
  1回のUndo/Redo、textなし、読取中のcaret・文書・mode・focus変更、IME composition優先を確認する。
- Firefoxから日本語をコピーし、`text/plain`が`\u...`でも`text/plain;charset=utf-8`が日本語なら、
  `Ctrl-Shift-v`で日本語が入ることを確認する。リスト直下のParagraphでは複数行が兄弟Itemになる。
  元のtextに含まれるリテラルの`\u...`は変換しない。通常の`Ctrl-v`はHTMLの構造（`pre`など）を保持する。
- `doc/specification/vim-operations.md`を空Root titleへ貼り、H1、Section、List、Table、Code、
  inline mark、linkを1 Noteとして取り込む。
- non-empty Note/Focused Sectionではwhole-note importせず通常pasteになる。
- unsupported Markdown領域をSource Blockで保持する。
- HTML sanitizerがscript、event属性、危険URLを除く。
- file picker、drop、Linux file Clipboard、Windows CF_HDROP、Normal `p/P`を確認する。
- 1 file 128 MiB、16 file、合計512 MiBの上限で部分commitしない。
- content重複時に論理Attachment IDを分けつつCAS objectを共有する。
- 画像ClipboardをPNGへ正規化し、寸法上限とalphaを確認する。
- Image 1 block yankを画像editorとfile managerへ貼れる。
- 混在yankで曖昧な画像dataを公開しない。
- Image resizeを1 Undoにし、cancel、Command、Markdown width往復を確認する。
- Image Buffer、`gf`/`Ctrl-w gf`/`Ctrl-o`、再起動復元、missing placeholderを確認する。

### 複数blockリストのnative手動確認

1. 空ListItemで`/`を入力し、Code、Quote/Alert、Table、Image、Attachmentをそれぞれ先頭blockとして作る。
   不要な空Paragraphを前置せず、picker取消時は`/`が残ることを確認する。
2. 直接Paragraphの途中で`Alt-Enter`は同じItem内のParagraph、`Enter`は兄弟Item、
   `Shift-Enter`はHard Breakを作る。HBの前後が行番号・`j/k`・`V`・`dd/yy`で別論理行になることを確認する。
3. Code/Table/Quote内では`Enter`はそのblockの操作、`Alt-Enter`はItem内のそのblockの直後へParagraph追加、
   `Ctrl-Enter`とNormalの`o`は所有ListItemの表示順で直後へ空Paragraphを持つItem追加となることを確認する。
   画像・添付・水平線でも同じ動作になり、子Listがあれば最初の子Listの先頭へ、なければ次の兄弟へ追加する。
   子List後方にParagraphなどがあっても既存の親子関係・表示順・IDが変わらないこと、
   追加先のList種別（番号付きの開始番号も含む）を維持すること、空の既存Itemを再利用しないこと、
   Undo/RedoとIME composition優先も確認する。`O`、List外の`o`/`Ctrl-Enter`の動作は変えない。
   リスト項目の`yy`/Visual Line `y`→`p`も同じ位置へ追加し、コピーした子孫の相対階層を保つ。
   `P`、文字単位の`p`、Table Cellのputは変わらないことも確認する。
4. 直接Paragraphに複数行のplain textをInsert paste/Normal `p/P`し、改行ごとの兄弟Itemになることを確認する。
   CRLF、途中の空行、末尾改行1個の除去、caret後方のtext・後続block・子Listが最後のItemへ残ることも確認する。
5. Markdown/HTML/内部Clipboardでは複数blockの構造を保ち、Code/Table内部へのplain pasteは既存の挙動を保つ。
   export→import、Undo/Redo、再起動後のblock構造・IDと`,g`/`/`の一致位置も確認する。
6. 空の先頭・後続Paragraphに日本語を入力し、IME確定Enterで兄弟Item作成や入力重複が起こらないことを確認する。

## 7. 検索とlink

- title/pathと本文の空白区切りAND検索
- updated time順と安定tie-break
- parent rename/move後のquery-time path解決
- 祖先変更で子孫本文再index/`updated_at`更新を行わないこと
- index schema不一致/破損時の再構築とCRDT fallback
- 大きなWorkspaceで最初の1文字を含むincremental queryがUIをblockしないこと
- Note内検索の件数即時表示と`n/N`現在位置更新
- fold/static chunk内一致への移動と必要祖先展開
- 外部link URLをNote内検索対象にせず、labelへcaretを置けること
- Internal Link rename追従、atomic caret、`gf`、欠損target
- 外部link statusline/tooltip、safe `gx`、relative/危険URL拒否
- Jump Listの記録対象、skip、stable position fallback

## 8. UI stateとfocus

- click、keyboard Window移動、Sidebar、Command-line、floating paneでfocus ownerを失わないこと
- active highlightと実DOM focus/key処理が同じsurfaceにあること
- inactive Windowにcaret DOMを残さないこと
- Empty Buffer、最後のNote Trash、最後のBuffer/Tab close
- Tab loop、直接番号移動、縮小layout、custom title bar drag/control
- 同方向splitの均等化
- `Ctrl-w t/b/w/W/p`の順序、循環、tab-local previous参照、Sidebarからの移動、閉じたWindow参照の除去
- `[N]Ctrl-w +/-/</>`のcount伝達とresize軸/符号、最小サイズ、`Ctrl-w =`の混在方向split均等化
- `Ctrl-w H/L/K/J`の外縁配置、大小文字の区別、Ctrlを保持したkey入力、Empty/Note/Image Bufferの共通操作
- 次frameへのselection反映前に配置を変更しても、移動元と他Windowのcaret/scrollが戻らないこと
- 境界drag中にEditorが再mountせず、pointer release時だけ保存すること、Esc/cancel/unmount/保存失敗でrollbackすること
- native buildでWindow/Tree/Outlineのresize、Zoom時の移動量、狭いApplication幅、focus/caret/scroll維持を確認すること
- TabPageごとのTree/Outline表示、幅、選択、fold復元
- Outlineの内部scroll、caret追従、fold/focus反映
- 相対行番号と現在absolute番号、大Note/static chunk、狭いWindowでの省略
- Note最大幅、indent grid、theme、font、Zoom
- release buildにdebug line/入力計測が存在しないこと

## 9. Namespace、履歴、移行・復旧

### Google Driveの追加検証

固定Restic 0.19.1/rclone 1.75.1のprepare/hash検証、`test:rclone`による暗号化configとstdio backend、
`MEMOKA_TEST_LONG_CLOUD_COPY=1 node scripts/test-rclone-boundary.mjs`による30秒超copyを実行する。
これらはlocal transportの成立性検証で、実OAuth/Driveの成功として扱わない。
schema 3移行、資格情報/環境/子孫process、lease、scheduler、GUI入力の回帰試験を通常verifyへ含める。
Windowsのowner IPCでは、接続中の空入力と切断を区別し、pipe bufferを超える応答を欠落なく受信する。
読み書きの期限切れでは未完了I/Oを取り消して完了を回収し、次の受信に影響を残さないことを確認する。
転送後検証のremote `dump/ls`回数が無関係な世代数に比例しないこと、対象世代・欠損・再試行の検証が残ることを確認する。
Driveのupload完了を保護済みと混同しないこと、検証待ちの再起動/元世代のlocal保持整理後の再開、copy応答喪失時の非重複、検証不一致時の保護日時維持を実Resticで検査する。
複数世代のdeferred転送が1回のcopyになること、最大16世代の境界、空/不正snapshot ID拒否、全source検査後だけの送信、batchの原子的な検証待ち移行を検査する。
失敗batchの全IDが再起動・新規capture後も優先され、部分転送/応答喪失からの再copyで重複しないこと、検証は別処理で1世代ずつ保護済みへ進むことを検査する。
進捗画面でまとめ転送の件数を表示し、単一世代の日時や転送途中の完了数で誤認させないことを検査する。実Driveの所要時間の改善はnative手動計測とし、local試験から秒数を推定しない。
未検証世代がある追加先ではforget/pruneを保留し、検証・整理の一時障害は新規uploadをbackoffしない。
通常quitは確定Core保存を最初に完了し、backup flush/status/転送待機を呼ばずにcancel・子process回収を行う。
実行中backupがあってもfinal captureを開始せず、Core保存失敗や停止失敗から強制終了しない。未包含編集は再起動後にcaptureできることをnative gateで確認する。
意図したCANCELLEDは既存のpending/保護日時を維持し、通信失敗回数やbackoffを追加しない。実際の通信失敗や認証障害は通常処理する。
切替・更新の転送待機はnativeで31秒・frontendで仮想120秒待機してもtimeout/cancelしない。未開始の検証・整理は保留し、取消で再開できる。
切替・更新取消では転送を中止せず、古い進捗poll・未開始の最終captureを止める。取消直後の再操作と遅延応答、取消済みIDの再解除、CLIの独立した待機も検査する。
確認済みの無変更cycleではCore barrier後のRestic/転送起動を省き、status・保護日時・世代を変更しない。cold startは省略しない。
変更epoch、保存先追加/変更/無効化、待ち件数0だが未包含世代がある台帳、repository ID不一致、local履歴/保存先の欠落・snapshot差替えを検査する。
転送済み検証待ちはno-op判定を妨げず、実行中のworkerを中断しない。native GUI＋owner CLI経由で無変更cycleの省略と経過時間を記録する。
一時cacheのowner-only権限・共有・破棄、uncached full check、実stdio JSON統計、長い/不正logの上限と秘密の非公開を確認する。
工程別表示、世代数と通信量の区別、未計測値、失敗/中断、poll中の入力draft保持を確認する。
ID再利用がleased handle内だけであり、copy後・実削除前のfresh照合が残ること、`cat config`と明示lock metadata診断以外のlockを省略しないことを確認する。
保持数以下のno-op、保持数超過・設定変更・24時間後の再評価、未完了writeの回収待ち永続化、
後続成功時にも古い回収待ちを失わないこと、prune前の未知snapshot拒否を確認する。
Linuxでは実Resticの中断後にlock fileが消えること、後始末中にtransportが生存すること、猶予超過で子孫が回収されることを確認する。
private repository内だけで異常終了を再現し、失効lockは明示unlockで解除、実行中lockは解除されず、世代の数・snapshot ID・check結果を維持することを実Resticで確認する。
同じ実Restic fixtureで、登録済みhandleの自動解除・元commandの再試行、稼働中lockでの有限失敗、正常な後続操作でunlockが増えないことを確認する。
単独復旧用handleと不一致IDには自動解除せず、copyでは登録済みsource/targetだけを扱うこと、解除前後のID照合、解除失敗、期限切れ、キャンセル、dump出力の巻き戻しを検査する。
正常時・exit 11以外では自動unlockを起動せず、恒常的なlock競合でも1 commandあたり各対象repositoryの解除1回・command再試行1回までとする。UIは自動復旧の工程と解除command数を世代の保護状態から区別する。
GUI表示・pollでlock診断が走らず、確認→解除確認→実行を必要とし、取消・遅延応答・保存先切替・BACKUP_BUSY・残存lockを正しく表示することを検査する。
CLIのlocks/unlockは登録対象だけに限定し、--remove-all/--force/任意repositoryを拒否する。owner内の稼働中leaseと排他し、capture/保護日時を変更せず、無関係なエラーを消さない。
復旧のWorkspace ID維持と追加保存先の除外、別OS-user接続のbinding未登録・不一致でwriter拒否、単独read/restoreとの分離を検証する。
実Driveでの残存lock復旧と異なるPCからのwriter拒否は別途手動確認し、local Restic/registry単体テストを実Driveの検証済みと扱わない。

Drive upload完了後、キー入力を継続していてもidle/tick待ちなしでverifyへ進み、他先のuploadを優先することを確認する。
upload済みreceiptで検証をskipしないこと、disabled/backoff/異なるrepositoryでは起動しないこと、完了後のno-op、終了・再起動での台帳引き継ぎを検証する。
保持整理は従来どおりidle/明示要求に限定し、転送済みと検証済みの件数・保護日時を混同しない。
新規Drive親・子の予約ID永続化、作成応答喪失後の同じID再開、409照合、重複したmarked親の拒否、名称だけの既存folderを流用しないことをfake control planeで検査する。
旧root/binding/repository IDと旧intentのroot配置、親選択の接続単位の保存とreset、未許可祖先でscopeを広げないこと、既存repository/shortcut/Shared Drive等の拒否を検証する。
Desktop Pickerのパラメータ、PKCE/state、選択なし/複数ID/重複queryの拒否、取消・期限切れ・鍵取得失敗で旧親/資格情報の保持を検査する。
UIの右下「戻る」が詳細/追加から一覧、接続管理から元画面へ1段ずつ戻り、一覧のみ「閉じる」となること、draft破棄確認・focus復帰・poll維持を確認する。
親選択中の登録/接続変更禁止、既存intentの固定親表示、離脱cancel、成功時のみ表示更新、選択操作だけでは転送を開始しないことを検証する。
実GoogleではPicker API有効化後、利用者作成folder選択・同一account確認・取消、複数新規先が`Memoka/Backup-…`または選択親配下へ作られること、旧root継続を手動確認する。
このnative Pickerと実Drive配置変更の手動確認は未実施であり、mock/loopback試験の合格で代替しない。

実Googleアカウントの認証、token更新、認可取消後の既存root参照、元config/keyringを使わない別OSユーザー/別PC復旧が正式提供のgateである。
Linux/WindowsでGUI転送中の編集・local Capture・履歴read、終了/切替/Updater、中断後の子孫回収もnative確認する。
未知object、shortcut、同名衝突では整理を止める。ゴミ箱移動と空き容量の区別を実確認する。
次の境界を別々に検証し、未実施を合格扱いしない。実験的機能の同梱と、Google Driveの正式な復旧保証を区別する。

| 境界       | 確認条件                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 認証       | OSブラウザの許可・拒否・取消、state不一致、callback再送、token期限後のrefresh、旧client/accountと一致しない再認証の拒否             |
| 資格情報   | keyring lock/利用不能、Linux権限・Windows ACL/reparse、GUI/CLI・別Workspaceの共有接続lease、更新失敗で旧config/keyを保持            |
| repository | 専用root作成の応答喪失とnonce照合、folder rename後のID継続、重複名・shortcut・unknown object・root/ID不一致で操作停止               |
| 実転送     | 複数先、独立password、30秒超の転送中の編集・local Capture・履歴read、再起動後のpending/検証再開、429/403/容量不足/通信断            |
| 終了と保持 | 通常quitの安全な中断、切替/更新の待機と取消、process/lock回収、最新世代保持、検証待ちの整理保留、Driveのゴミ箱移動                  |
| 単独復旧   | 元Workspace・config・keyringのない別OSユーザー/PCで同じclientへ認証し、保管folder IDとpasswordだけでlist/check/restore              |
| 認可取消   | Google側でproject認可を取り消した後の再認証と既存rootアクセス。不可なら自動scope拡大・空repository再作成で回避しない                |
| 配布       | AppImageとCLIに同じ有効なDesktop clientを同梱し、個人の設定fileなしで認証操作が有効。通常panel表示だけではkeyring/networkを使わない |

実アカウント試験は専用の非機密Workspaceで行う。OS、Git revision、sidecar hash、日時、試験条件と成否を
CI/ローカル証拠/Release本文へ記録し、本文・token・password・認可code・生の子process出力を残さない。
通常の自動試験は実Googleへ接続せず、配布OAuth設定の不足・Web client・利用者tokenの混入・binaryへの組み込み漏れも検査する。
署名付きassetそのものの検査と、local/fake transportの検査を混同しない。
`tauri:history-e2e`は`MEMOKA_TAURI_APP`と`MEMOKA_E2E_CLI`で取得済み配布物を指定できる。
OAuth組み込み版のpanel試験には`MEMOKA_E2E_GOOGLE_CONFIGURED=1`を指定し、個人設定なしで接続操作が有効になることを確認する。

### 共通回帰試験

- 初回data area選択、既存area再open、非空未知directory拒否
- Workspace切替成功と全失敗点でのrollback
- 同一Workspaceの二重起動拒否と既存Window activation
- group-onlyとNote付きNamespace、Entry/Note ID分離、一意配置、循環・dangling・duplicate拒否
- Entry IDとposition tie-breakによる安定順序、旧Note順序とTabの選択/foldの移行
- subtree Trash/restoreの原子性、独立して削除済みの子孫の扱い、group-only Trash検索
- Namespace親・group名変更で本文FTS行とNote updated_atを更新しないこと
- Root H1〜H6境界、Focused Sectionの絶対深さ、複数H1正規化によるH7の全体拒否
- 失敗時にNote、IDs、revision、Undoが変化せず、plain text fallbackもしないこと
- DB2/3/4/5の最終Yjs状態をlive/Trash/Help全件preflightし、H6超過・破損時は元DB/WAL/添付/旧mirrorを変更しないこと
- rollback用SQLite Online Backup、DB6へのatomic移行、途中失敗後の再試行
- 空Workspaceの初回世代、dirty起動・interval・切替・更新前capture、通常終了ではcaptureせず次回起動へ持越し、UI/cacheだけならepoch不変
- 長いNoteのcapture/copy中も編集可能であること、snapshotとdescriptorの同一時点・hash/revision/catalog一致
- 添付全件（未参照を含む）とknown_missing、破損・symlink・reparse拒否、1 GiB reserve不足
- 独立repositoryのkey/id、password漏洩防止、repository消失・取り違え、crash後のaccepted世代再構築
- 新しい世代からのcopy、capture日時保持、idempotence、未接続時のpending/expired/protected区別
- 保存先別の保持数（既定: 直近48 OR 日次30 OR 月次12）、0指定、dry-runと実削除の一致、最新valid世代保護、24時間のidle prune
- 複数保存先の独立パスワード・再登録・無効化/再開・一部未接続・転送時間切れ、旧単一先/初期化intent移行
- backup-settingsの保存先一覧→進捗/設定→一覧、追加/Google接続管理、未保存入力の破棄確認、フォーカス復帰、hiddenタブと折り畳み注意欄のTab順
- 一覧の検証済み/転送済み/対象数、保存先だけに残る古い世代、保持削除・期限切れ・検証待ち・中断/再起動・未確定値。表示だけでは外部通信やstatus書き込みが起きないこと
- 状態pollと詳細タブ切替でのdraft保持、絶対日時+ago、狭幅での一覧/本文内部scrollと固定ヘッダー/フッター、Light/Dark themeとZoom、日時clockによるEditor再描画がないこと
- capture/copyとmaintenanceのlease、cancel後のphase開始禁止、timeout/cancel時の子process回収
- 終了進捗・retry/cancel、Core保存失敗/停止失敗時は強制終了禁止、切替・更新の追加先待機には30秒上限なし
- Native CLIとGUIの論理行契約、revision/query-bound cursor、Trash明示、同世代link/画像、URLをfetchしないこと
- GUIありは保存barrier付きowner IPC、GUIなしは同じlease。IPC失敗後にheadless fallbackしないこと
- readのみではmigration・Help同期・repo初期化をせず、DISPLAY/DBUSなしでCLIが動くこと
- repository-only list/check/full/restore、fresh target、ID/revision保持とUI/cache/Undoの非復元
- 旧mirror verify/restore互換のみrevision 1 baseline。旧ファイルを自動削除しないこと
- `shutdown.wait_for_mirror`を無視しても、他の有効な設定が保持されること

`corepack pnpm tauri:history-e2e`は一時Workspaceで実GUI・owner IPC・同梱Resticを接続する。
group作成/改名、子Note配置、確定保存barrier、現在と過去のNamespace/本文の分離、
backup処理中の別WindowのInsert入力、読み取り専用preview、previewの一覧遷移後のCtrl-cとfocus復帰を確認する。
入力計測はkeydownから次のanimation frameまでの参考値であり、実機IMEの計測とは区別する。
実行前に`corepack pnpm tauri:build`と`corepack pnpm cli:build`で対象binaryを生成する。

### 外部エージェントCLI編集とタスク

- `agent_edit`のnative testで、Unicode・同一mark segment・0/多重/重複一致・base offset・段落の空化を検証する。
- 親Bodyと子Sectionを区別し、入れ子Paragraphの置換とanchor拒否、既存ID維持、同一gapの順序を検査する。
- 対応Markdown、literalな置換、safe/internal link、未対応構造のbatch全体拒否、入力・block・diffの上限を検査する。
- no-op/dry-run、保存前/SQL確定前失敗、確定後応答喪失、永続receipt、再送・revision conflict・cursor staleを検査する。
- `reader_cli`でDISPLAY/DBUSなしの編集、旧schema非移行、stdout JSON、owner失敗時の直接write fallback禁止を確認する。
- `corepack pnpm tauri:agent-e2e`で起動GUIとstandaloneの意味的結果を比較し、複数Window、非表示Note、
  IME拒否、既存Undo、SQL故障時の非公開と確定後応答回復を検証する。独立した一時Workspaceだけを使う。
  debug buildを`MEMOKA_TAURI_APP`、対応CLIを`MEMOKA_E2E_CLI`で指定する。release artifactでは
  `MEMOKA_E2E_AGENT_FAULTS=0`でdebug専用故障注入を除外する。Linuxで別GUIを起動したまま実行する場合はprivate D-Bus sessionを使う。
- Task ListのMarkdown/HTML/Clipboard、rich/nested/mixed内容、click/Normal Enter、新規未完了Item、Undo、IME優先を検査する。
- Native実行環境でcheckboxの表示、caretがcheckboxに入らないこと、Section/Details titleと本文のEnter差異を確認する。
- `agent:reference:check`でCLI定義と共通スキルの生成参照資料を同期する。スキルのインストール操作はテスト中に利用者の設定へ適用しない。

## 10. 大規模dataと性能

10 MiBかつ10万論理行相当のNoteDocで次を自動gateおよびnative buildで確認する。

- plain text/Markdown paste
- BodyChunk境界をまたぐVim操作、IME、Undo、検索
- 保存、再起動、line number、fold、Outline
- 編集可能DOMが最大6 chunk相当
- paste中のcancelと完了時1 transaction

回帰検出基準は通常入力1操作500 ms以内、paste 30秒以内とする。
native hardwareの目標は通常入力p95 16 ms、高負荷p95 50 ms、application起動1,000 ms、
Note open 50 ms、検索初回100 msである。debug計測は直近120件のrolling sampleを使う。

## 11. 配布

- Linux/Windows CIの通常検証を通す。
- AppImage内にhost runtimeと衝突する不要libraryを含めない。
- AppImage signatureと`latest.json`を検証する。
- AppImageとstandalone CLIに同じ固定版Resticとlicenseを同梱し、Releaseに添付するSBOMへResticのGo moduleを含める。
- CLIのLinux dynamic dependencyにGTK/WebKitを含まないこと。Windows source buildでもIPC・履歴・restoreを検証する。
- 公開ReleaseへWindows executable/MSIを添付しない。
- draft assetそのものをGNOMEとSwayで確認してから、再buildせず公開する。
- Updaterのno-update、offline、署名不正、download失敗、flush失敗を確認する。
- log rotationを5 MiB×3世代以内にし、content/path/IDが記録されないことを確認する。
