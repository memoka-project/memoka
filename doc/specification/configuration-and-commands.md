# 設定とCommand

[仕様書へ戻る](../specification.md)

## 1. application設定

設定fileはTauriが解決するapplication config directoryの`config.toml`である。
fileが存在しない場合は既定値で動作し、起動のためだけに自動作成しない。
themeなどをCommandから確定した場合は、既存commentと無関係な設定を保って必要fieldだけを保存する。

設定はWorkspaceではなくapplication全体へ適用する。

未知field、未知command ID、型不一致、範囲外値、曖昧key bindingがある場合はwarningを表示し、
部分的な不明設定を推測して適用せず、key設定全体を安全な既定値へ戻す。

## 2. 既定値

| 設定                               | 既定値                                   | 範囲/候補                                 |
| ---------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `theme`                            | `nightfox`                               | 収録7テーマまたは定義済みカスタムテーマID |
| `font_family`                      | Interを先頭とするsystem sans-serif stack | validなCSS font-family                    |
| `zoom_percent`                     | 100                                      | 50〜200、10刻み                           |
| `note_max_width_px`                | 1000                                     | 320〜4096、0で無効                        |
| `line_number_min_width_px`         | 480                                      | 240〜4096、0で常時表示                    |
| `indent_width_px`                  | 24                                       | 16〜64                                    |
| `leader`                           | `,`                                      | 1 Unicode文字                             |
| `vim.whichwrap`                    | true                                     | boolean                                   |
| `japanese.word_segmentation`       | fine                                     | fine/budoux/unicode                       |
| `japanese.line_break_segmentation` | fine                                     | fine/budoux/native                        |

旧設定`shutdown.wait_for_mirror`は既知の無視キーとして受け付ける。値に関係なく旧mirrorを動かさず、
このキーだけを理由に他の有効な設定を既定へ戻さない。バックアップの保存間隔・複数追加先・有効状態・保存先ごとの直近/日次/月次保持数は
Workspaceごとの設定であり、`:backup-settings`から変更する。パスワードはOS資格情報ストアのみへ保存する。

`:backup-settings`は中央floating modalの保存先一覧を入口とする。先頭は常時有効のローカル履歴、
以降は登録順の追加保存先で、無効・失敗した保存先も表示する。列は「種類・保存先」「状態・工程」
「最終保存（検証済み）」「保存世代（検証済み／転送済み／保存対象）」「進捗・設定」の操作とする。
保持数は一覧へ併記せず設定タブだけに表示する。最大幅1,100pxでviewport内に収め、一覧・詳細本文を内部scrollする。
「進捗」「設定」は同一modal内の保存先詳細を対応するタブで開く。進捗は工程・診断・失敗・再試行、
および明示操作の「ロックを確認」「失効したロックを解除」を持つ。通常pollではlockを取得しない。
通常のrepository処理でlock競合を検出した場合は失効lockを自動解除して一度だけ再試行し、進捗に自動復旧の工程を表示する。強制解除は提供しない。
設定は保持数・無効化・解除・既存パスワード再登録（ローカル履歴は自動保存間隔も）を扱う。
「保存先を追加」は種類・ディレクトリ/Google接続・保持数・パスワードを入力する別画面で、成功後は一覧へ戻る。
Google接続管理は追加画面とDrive詳細の設定から開く共通subviewとする。
右下のfooterボタンは一覧のみ「閉じる」、詳細・追加・Google接続管理は「戻る」とする。右上の戻るボタンは置かない。
このボタンとEsc/Ctrl-cはsubviewから元画面、詳細/追加から一覧、一覧からmodalを閉じる順に戻る。
未保存入力を破棄する離脱は確認し、pollや詳細タブ切替ではdraftを維持する。入力パスワードは送信・取消・離脱時に破棄する。
注意書きは共通「注意事項」欄へ集約し、保持数削減・解除等の直前の注意は同じ欄で明示する。入力/処理エラーは対象箇所へ表示する。
Google接続はWorkspace設定と別のOSユーザー単位で共有し、
認証operationの進捗だけをpollする。接続の再認証/取消/ローカル解除と転送の開始/中断は別の操作である。
Google追加画面には新規保存先の親folderを表示する。既定は自動`Memoka`で、Google Desktop Pickerによる通常folderの明示選択・自動設定へのresetを提供する。
選択済み親は接続ごとに記憶し、次回の新規登録に使う。再開intentには固定済みの親（旧intentはroot直下）を表示し、その親変更を無効にする。
親選択中は接続変更・保存先登録との同時操作を防ぎ、画面から離脱すると未完了の認可を取り消す。選択だけで転送を予約しない。
Googleは実験的で、公式AppImageとstandalone CLIへMemoka用Desktop OAuth clientを組み込む。
CLIの`--client-file`、`MEMOKA_GOOGLE_OAUTH_CLIENT_FILE`で指定した絶対path、application config directoryの
`google-desktop-client.json`、組み込み設定の順に解決する。明示設定が不正なら組み込み設定へfallbackしない。
source buildでいずれも設定されていない場合は接続操作だけを無効化する。
配置・配布と管理者設定は[OAuth clientの仕様](platform-release-and-security.md#72-oauth-clientの設定と配布)を参照する。
tokenやパスワードを`config.toml`へ記載してはならない。
通常cloudの転送・検証・整理は1単位1時間の固定上限を持つ。通常終了はCore保存後に処理を中断し、未完了分を次回へ回す。
切替・更新は追加先の転送を待ち、待機全体の時間上限は設けない。未開始のDrive検証・整理は後回しにする。

既定font stackは次である。

```text
Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

## 3. 設定例

```toml
theme = "nightfox"
font_family = 'Noto Sans CJK JP, system-ui, sans-serif'
zoom_percent = 110
note_max_width_px = 1000
line_number_min_width_px = 480
indent_width_px = 24
leader = ","

[vim]
whichwrap = true

[japanese]
word_segmentation = "fine"
line_break_segmentation = "fine"

[keymap.shared_navigation]
"cursor.logical-up" = ["k"]
"cursor.logical-down" = ["j"]

[keymap.tree_normal]
"note.create_child" = ["c"]

[keymap.visual_char]
"selection.format" = ["m"]

[keymap.table]
"table.next_cell" = ["Tab"]
"table.previous_cell" = ["Shift+Tab"]
"mode.visual-block" = ["Ctrl+v"]
```

## 4. keymap namespace

変更できるのは定義済みcommand IDへのkey sequenceである。任意scriptや任意Core commandは実行できない。

### 4.1 shared navigation

- `cursor.left`
- `cursor.right`
- `cursor.logical-up`
- `cursor.logical-down`
- `cursor.document-start`
- `cursor.document-end`
- `cursor.page-up`
- `cursor.page-down`
- `cursor.half-page-up`
- `cursor.half-page-down`

### 4.2 Tree

- `note.open`
- `note.create_sibling_after`
- `note.create_child`
- `note.create_root`
- `note.move_up`
- `note.move_down`
- `note.move_outdent`
- `note.move_indent`
- `note.move_to_trash`
- `trash.open`
- `sidebar.close`

`note.*`は既存設定との互換IDである。移動・削除の対象はNamespaceEntryとなり、グループも扱う。
`note.open`はNote EntryならNoteを開き、グループなら折り畳みをtoggleする。
新規作成はNote付きEntryを作る。グループ作成とrenameは`:group`、`:rename-group`で行う。

### 4.3 Visual Char

- `selection.format`

### 4.4 Table

- `table.next_cell`
- `table.previous_cell`
- `mode.visual-block`

`table.action_picker`は廃止済みである。Context Actionsは固定Leader categoryの`<Leader>a`を使う。

同じsurfaceで完全一致またはprefix関係になる曖昧binding、application予約sequenceと衝突するTree bindingを拒否する。

## 5. Leader namespace

物理Leader文字だけを`leader`で変更できる。後続categoryはHelp、設定、将来の拡張で安定させるため固定する。
active/予約一覧は[Vim操作](vim-operations.md#13-leader)を参照する。

未実装の予約categoryを別commandへ割り当てない。

## 6. Command-line

Normalまたはapplication surfaceで`:`を押すとApplication最下部の共通Command-lineを開く。
Sidebar focus中も利用できる。

- Enter: 実行
- Esc/Ctrl-c: cancel
- IME composition中のEnter: 変換を優先し、commandを実行しない
- command名: case-insensitive
- 引数: 定義上optionalなcommandに1つまで
- 未知command、余分な引数: 入力面を保ってerrorを表示

完全なVim Ex parserではない。`:q!`、range、pipe、substituteなど、catalog外の構文を推測しない。
`<Leader>c`は共通検索paneからcommandを選び、canonical nameをCommand-lineへ転記する。

## 7. Command catalog

| Command                                           | 動作                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `:tree`                                           | Treeを開いてfocus                                                             |
| `:group`                                          | 選択Entryの子（選択なしならtop-level）にgroup作成                             |
| `:rename-group`                                   | 選択groupのname変更                                                           |
| `:backup`                                         | 保存barrier後にlocal captureと追加先copyを要求                                |
| `:backup-settings`                                | 保存状態表示とWorkspace別間隔・複数追加先・有効状態・保持数・OS資格情報の設定 |
| `:history`                                        | 現在resourceまたはWorkspaceのread-only履歴                                    |
| `:recovery`                                       | 現在Noteの削除・型変更で保護されたSection・Blockの復旧                        |
| `:sync`                                           | 自動同期の再接続・差分確認を要求                                              |
| `:sync-settings`                                  | 端末一覧と追加・接続情報更新・一時停止・登録解除                              |
| `:trash`                                          | deleted Note検索                                                              |
| `:buffers` / `:ls`                                | load済みBuffer検索                                                            |
| `:outline`                                        | active WindowのOutlineを開いてfocus                                           |
| `:split` / `:sp`                                  | 現在Windowを上下分割                                                          |
| `:vsplit` / `:vs`                                 | 現在Windowを左右分割                                                          |
| `:close` / `:clo`                                 | 現在Windowを閉じる                                                            |
| `:bdelete` / `:bd`                                | 現在Bufferを閉じてWindowを空にする                                            |
| `:tabnew`                                         | Sidebar非表示の空TabPageを作る                                                |
| `:tabclose` / `:tabc`                             | 現在TabPageを閉じる                                                           |
| `:tabnext` / `:tabn`                              | 次Tabへ循環移動                                                               |
| `:tabprevious` / `:tabp`                          | 前Tabへ循環移動                                                               |
| `:paste-markdown`                                 | ClipboardをMarkdownとして現在位置へpaste                                      |
| `:paste-html`                                     | ClipboardをHTMLとして現在位置へpaste                                          |
| `:attach`                                         | file pickerから現在位置へ添付                                                 |
| `:image-width [10..100%]`                         | 現在画像の幅を表示/変更                                                       |
| `:switch-workspace`                               | 別Workspaceデータ領域へ切替                                                   |
| `:update`                                         | signed updateを確認/適用                                                      |
| `:version` / `:ver`                               | Memoka、Tauri、OS、architectureを表示                                         |
| `:diagnostics` / `:diag`                          | local診断情報とlog directoryを表示                                            |
| `:colorscheme [name]` / `:colo`                   | Nightfox themeを選択/直接変更                                                 |
| `:font`                                           | application fontを選択                                                        |
| `:zoom [50..200]`                                 | Zoomを表示/変更                                                               |
| `:note-width [px/off]`                            | Note最大表示幅を表示/変更/解除                                                |
| `:line-number-min-width [px/off]`                 | 行番号を表示するWindow最小幅を表示/変更                                       |
| `:indent-width [16..64]`                          | 共通indent幅を表示/変更                                                       |
| `:word-segmentation [mode]` / `:word-segment`     | 日本語word分割を表示/変更                                                     |
| `:line-break-segmentation [mode]` / `:line-break` | 日本語表示改行を表示/変更                                                     |
| `:quit` / `:q` / `:qa`                            | 確定編集を保存し、バックアップを安全に中断して終了（完了は待たない）          |
| `:help`                                           | 管理Help Noteを同期して開く                                                   |

同期設定はWorkspaceコピーごとに`:sync-settings`で管理する。既定は無効で、有効化・参加操作前に待受けしない。
端末一覧、接続・受信・反映・添付の工程、最終反映、待機件数と容量を中央floating modalへ表示する。
追加・鍵を照合するアドレス更新・一時停止と再開・登録解除、復旧画面への入口を提供する。
起動時のWorkspace選択には「別端末から受信」を置く。操作の詳細は[端末間同期](device-synchronization.md)を参照する。

## 8. live setting picker

Themeとfontのpickerは選択中の候補をApplicationへlive previewする。

- Enterで確定し、`config.toml`へ保存する。
- Esc/Ctrl-cで開始時の値へ戻す。
- Themeは`:colorscheme duskfox`のように直接指定できる。
- `:font`はpresetまたはvalidな任意CSS font-familyを選べる。

Zoomは`Ctrl+=`/`Ctrl++`で10%拡大、`Ctrl+-`で10%縮小、`Ctrl+0`で100%へ戻す。

## 9. 表示設定

`note_max_width_px`は行番号gutterと本文paddingを含むNote canvas全体の上限である。
0では上限を解除する。

`line_number_min_width_px`は各Editor Windowの実幅に適用する。Windowがこれより狭ければ行番号を隠す。
0では常時表示する。

`indent_width_px`はSection、List、Table、Code Block、Image、行番号境界から最初のSection guideまでの
共通grid幅である。List markerから本文までの文字間隔は固定し、indent値そのものにはしない。

## 10. 日本語設定

`word_segmentation`は`w/b/e`、word operator、`iw/aw`、Insert `Ctrl-w`へ即時適用する。
`line_break_segmentation`はEditor本文と本文検索previewの表示だけへ適用し、文書dataを変更しない。

`:word-segmentation`と`:line-break-segmentation`は引数なしで現在値を表示し、
validなmodeを指定すると即時反映して`config.toml`へ保存する。

## 11. Help Note

利用者向けHelpの原稿はrepositoryの[`doc/help.md`](../help.md)を唯一のsourceとする。
`:help`はこのMarkdownを通常のwhole-note Markdownと同じschema/parserで取り込み、system roleを持つ
「Memoka help」Noteを作成または同期して現在Windowへ開く。見出し階層、List、Table、Alert、inline mark、
外部linkを対応するMemoka構造へ変換し、Help内の見出しanchor linkはInternal Section Linkへ変換する。

SectionとblockにはNote ID、見出しpath、block位置から導出した安定IDを使う。同じ原稿を再同期してもidentityを
維持し、Help Noteへの手動編集は端末内に限り、次回`:help`で原稿の内容へ置き換える。原稿のH1不一致、重複見出しanchor、
未解決anchor、未対応Markdown blockは同期errorとして扱い、不完全なHelpへ黙って置き換えない。

Help Noteは利用者向け操作情報の正本表示であり、user-visibleなkey、command、設定、制約を変更した場合は
この仕様と`doc/help.md`を実装と同じcommitで更新する。

## 12. CLIからの設定変更

`memoka-cli config get`は`config.toml`のpath・有効値・file revisionを読み、`config schema`は機械可読な契約を返す。
`config set --input FILE|- [--dry-run]`はJSONの`set`/`unset`をまとめて適用する。いずれも`--format json`に対応する。
設定はOSユーザーのapplication全体に適用し、`--workspace`は受理しない。

対応する設定とGUI commandは次のとおり。両経路で同じ値の検証と保存処理を使う。

| CLIの設定key                       | GUI command                                |
| ---------------------------------- | ------------------------------------------ |
| `theme`                            | `:colorscheme`                             |
| `font_family`                      | `:font`                                    |
| `zoom_percent`                     | `:zoom`                                    |
| `note_max_width_px`                | `:note-width`                              |
| `line_number_min_width_px`         | `:line-number-min-width`                   |
| `indent_width_px`                  | `:indent-width`                            |
| `japanese.word_segmentation`       | `:word-segmentation`                       |
| `japanese.line_break_segmentation` | `:line-break-segmentation`                 |
| `themes.<id>`                      | カスタムテーマの定義。選択は`:colorscheme` |

GUIは1秒間隔およびOS windowへのfocus復帰時に小さい設定fileのhashを確認し、変更時のみ再parseする。
上表の設定をEditorの再mount・Noteの編集・focusやkeymapの変更なしに再適用する。font/幅変更で必要なlayout再計算は行う。
IME変換中・theme/fontのpreview中は再適用を保留する。GUI自身の保存と競合する古いreload結果は捨てる。
不正fileのlive reloadはwarningを出し、既定へ切り替えず現在の表示を維持する。起動時の既定fallbackは従来どおり。
Leader・keymap・`vim.whichwrap`の変更はこのCLIでは受理せず、手動変更後の再起動を必要とする。

preview・排他・競合・応答形式は[外部エージェントCLI](agent-editing.md#9-アプリ設定の読み書き)を参照する。

## 13. カスタムカラーテーマ

`[themes.<id>]`の`base`は収録7テーマのいずれか、`name`は任意の表示名、`palette`は任意の色override mapとする。
IDは`[a-z][a-z0-9-]{0,47}`で、収録テーマ名を予約する。定義は64件まで、表示名は空白のみや制御文字を除く128 UTF-8 bytes以下。
baseに別のカスタムテーマは指定せず、連鎖や循環を作らない。明暗区分と省略色はbaseを継承する。

paletteは`bg0`〜`bg4`、`fg0`〜`fg3`、`selection`、`selectionStrong`、`comment`、
`black`、`red`、`green`、`yellow`、`blue`、`magenta`、`cyan`、`white`、`orange`、`pink`に限る。
値は`#RRGGBB`のみ。CSS、外部stylesheet、URL、JavaScriptを受理・実行しない。
paletteから既存のsemantic token層を再生成し、本文・装飾・見出し・Outline・mode・検索・modal等に一貫して適用する。

`theme = "<id>"`または`:colorscheme <id>`で選択する。引数なしのpickerにも表示し、preview・取消・保存は収録テーマと共通。
CLIの`set["themes.<id>"]`は1定義全体を置き換え、他の定義は保持する。テーマ追加と選択は同じrequestにまとめられる。
選択中の定義だけを削除するrequestは拒否し、同時に別テーマを選ぶか`theme`をunsetする。
