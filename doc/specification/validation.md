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
- Workspace parent欠損互換、cycle、self-parent、orphan、deleted-parent/live-child拒否
- jitter付きFractional Indexingの順序、衝突tie-break、局所再採番
- NoteDoc v2からBodyChunkを持つv3へのmigration
- SQLite v2/v3からv4へのmigration backup
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

## 9. Workspace、mirror、復旧

- 初回data area選択、既存area再open、非空未知directory拒否
- Workspace切替成功と全失敗点でのrollback
- 同一Workspaceの二重起動拒否と既存Window activation
- 起動時revision一致ならmirrorをskipすること
- 通常編集で変更Noteだけをdelta publishすること
- title/path変更または破損時の完全再構築
- frontend generationのyield/cancel/coalescingとEditor応答性
- staging chunk retry、hash/size、fsync、manifest-last、旧managed file削除
- crash marker、stale staging、symlink、path traversal、case/NFC衝突
- 終了時mirror待機のtrue/falseとprogress、flush失敗時の終了中止
- CLI verifyとfresh target restore
- restore後revision 1、Attachment CAS、FTS再構築、UI/Undo非復元

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
- 公開ReleaseへWindows executable/MSIを添付しない。
- draft assetそのものをGNOMEとSwayで確認してから、再buildせず公開する。
- Updaterのno-update、offline、署名不正、download失敗、flush失敗を確認する。
- log rotationを5 MiB×3世代以内にし、content/path/IDが記録されないことを確認する。
