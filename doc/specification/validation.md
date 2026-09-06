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
- NoteDoc v2からBodyChunkを持つv3へのmigration
- SQLite v2/v3/v4からv5への全件preflightとrollback copy
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
- TabPageごとのTree/Outline表示、幅、選択、fold復元
- Outlineの内部scroll、caret追従、fold/focus反映
- 相対行番号と現在absolute番号、大Note/static chunk、狭いWindowでの省略
- Note最大幅、indent grid、theme、font、Zoom
- release buildにdebug line/入力計測が存在しないこと

## 9. Namespace、履歴、移行・復旧

- 初回data area選択、既存area再open、非空未知directory拒否
- Workspace切替成功と全失敗点でのrollback
- 同一Workspaceの二重起動拒否と既存Window activation
- group-onlyとNote付きNamespace、Entry/Note ID分離、一意配置、循環・dangling・duplicate拒否
- Entry IDとposition tie-breakによる安定順序、旧Note順序とTabの選択/foldの移行
- subtree Trash/restoreの原子性、独立して削除済みの子孫の扱い、group-only Trash検索
- Namespace親・group名変更で本文FTS行とNote updated_atを更新しないこと
- Root H1〜H6境界、Focused Sectionの絶対深さ、複数H1正規化によるH7の全体拒否
- 失敗時にNote、IDs、revision、Undoが変化せず、plain text fallbackもしないこと
- DB2/3/4の最終Yjs状態をlive/Trash/Help全件preflightし、H6超過・破損時は元DB/WAL/添付/旧mirrorを変更しないこと
- rollback用SQLite Online Backup、DB5へのatomic移行、途中失敗後の再試行
- 空Workspaceの初回世代、dirty起動・interval・終了・切替・更新前capture、UI/cacheだけならepoch不変
- 長いNoteのcapture/copy中も編集可能であること、snapshotとdescriptorの同一時点・hash/revision/catalog一致
- 添付全件（未参照を含む）とknown_missing、破損・symlink・reparse拒否、1 GiB reserve不足
- 独立repositoryのkey/id、password漏洩防止、repository消失・取り違え、crash後のaccepted世代再構築
- 新しい世代からのcopy、capture日時保持、idempotence、未接続時のpending/expired/protected区別
- 直近48 OR 日次30 OR 月次12、dry-runと実削除の一致、最新valid世代保護、24時間のidle prune
- capture/copyとmaintenanceのlease、cancel後のphase開始禁止、timeout/cancel時の子process回収
- 終了進捗・retry/cancel、Core保存失敗時はskip禁止、追加先待機時間上限
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
