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

| 設定                               | 既定値                                   | 範囲/候補                                                 |
| ---------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `theme`                            | `nightfox`                               | nightfox/dayfox/dawnfox/duskfox/nordfox/terafox/carbonfox |
| `font_family`                      | Interを先頭とするsystem sans-serif stack | validなCSS font-family                                    |
| `zoom_percent`                     | 100                                      | 50〜200、10刻み                                           |
| `note_max_width_px`                | 1000                                     | 320〜4096、0で無効                                        |
| `line_number_min_width_px`         | 480                                      | 240〜4096、0で常時表示                                    |
| `indent_width_px`                  | 24                                       | 16〜64                                                    |
| `leader`                           | `,`                                      | 1 Unicode文字                                             |
| `vim.whichwrap`                    | true                                     | boolean                                                   |
| `japanese.word_segmentation`       | fine                                     | fine/budoux/unicode                                       |
| `japanese.line_break_segmentation` | fine                                     | fine/budoux/native                                        |
| `shutdown.wait_for_mirror`         | true                                     | boolean                                                   |

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

[shutdown]
wait_for_mirror = true

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

| Command                                           | 動作                                     |
| ------------------------------------------------- | ---------------------------------------- |
| `:tree`                                           | Treeを開いてfocus                        |
| `:trash`                                          | deleted Note検索                         |
| `:buffers` / `:ls`                                | load済みBuffer検索                       |
| `:outline`                                        | active WindowのOutlineを開いてfocus      |
| `:split` / `:sp`                                  | 現在Windowを上下分割                     |
| `:vsplit` / `:vs`                                 | 現在Windowを左右分割                     |
| `:close` / `:clo`                                 | 現在Windowを閉じる                       |
| `:bdelete` / `:bd`                                | 現在Bufferを閉じてWindowを空にする       |
| `:tabnew`                                         | Sidebar非表示の空TabPageを作る           |
| `:tabclose` / `:tabc`                             | 現在TabPageを閉じる                      |
| `:tabnext` / `:tabn`                              | 次Tabへ循環移動                          |
| `:tabprevious` / `:tabp`                          | 前Tabへ循環移動                          |
| `:paste-markdown`                                 | ClipboardをMarkdownとして現在位置へpaste |
| `:paste-html`                                     | ClipboardをHTMLとして現在位置へpaste     |
| `:attach`                                         | file pickerから現在位置へ添付            |
| `:image-width [10..100%]`                         | 現在画像の幅を表示/変更                  |
| `:switch-workspace`                               | 別Workspaceデータ領域へ切替              |
| `:update`                                         | signed updateを確認/適用                 |
| `:version` / `:ver`                               | Memoka、Tauri、OS、architectureを表示    |
| `:diagnostics` / `:diag`                          | local診断情報とlog directoryを表示       |
| `:colorscheme [name]` / `:colo`                   | Nightfox themeを選択/直接変更            |
| `:font`                                           | application fontを選択                   |
| `:zoom [50..200]`                                 | Zoomを表示/変更                          |
| `:note-width [px/off]`                            | Note最大表示幅を表示/変更/解除           |
| `:line-number-min-width [px/off]`                 | 行番号を表示するWindow最小幅を表示/変更  |
| `:indent-width [16..64]`                          | 共通indent幅を表示/変更                  |
| `:word-segmentation [mode]` / `:word-segment`     | 日本語word分割を表示/変更                |
| `:line-break-segmentation [mode]` / `:line-break` | 日本語表示改行を表示/変更                |
| `:quit` / `:q` / `:qa`                            | 保存と必要なmirror完了後に終了           |
| `:help`                                           | 管理Help Noteを同期して開く              |

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
維持し、Help Noteへの手動編集は次回`:help`で原稿の内容へ置き換える。原稿のH1不一致、重複見出しanchor、
未解決anchor、未対応Markdown blockは同期errorとして扱い、不完全なHelpへ黙って置き換えない。

Help Noteは利用者向け操作情報の正本表示であり、user-visibleなkey、command、設定、制約を変更した場合は
この仕様と`doc/help.md`を実装と同じcommitで更新する。
