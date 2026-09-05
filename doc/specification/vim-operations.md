# Vim操作

[仕様書へ戻る](../specification.md)

## 1. 方針

MemokaはVimのkey sequenceとmode概念を採用するが、text fileではなくSectionと構造blockを編集する。
そのため、同じkeyでもVimのbyte/物理行ではなく、[Memokaの論理行](content-model-and-editor.md#4-論理行)、
ListItem、Table Cell、atomic nodeを対象にする場合がある。

完全なVim互換を表明しない。この文書に記載のないcommand、register、macro、text object、Ex command、
mappingは未対応である。

## 2. Modeとcaret

| Mode         | 主な用途        | caret/statusline                            |
| ------------ | --------------- | ------------------------------------------- |
| Normal       | 移動とcommand   | 文字またはatomic nodeを覆う四角、青系NORMAL |
| Insert       | text入力        | 点滅しない縦棒、緑系INSERT                  |
| Replace      | 連続置換        | 下線、赤系REPLACE                           |
| Visual Char  | 文字範囲        | head位置の四角、紫系VISUAL CHAR             |
| Visual Line  | 論理行/構造範囲 | head位置の四角、紫系VISUAL LINE             |
| Visual Block | Table Cell矩形  | head Cell、紫系VISUAL BLOCK                 |

Normal caretは論理行末尾の存在しない文字位置へ進まず、最後の文字で止まる。Internal Linkやatomic blockでは
対象全体を覆う。InsertからEsc/Ctrl-cでNormalへ戻ると、Insert caret直前の文字へNormal caretを置く。

`r`の置換文字待機中と`R`のReplace modeではcaretを下線にする。

## 3. Count

数字prefixは対応commandを繰り返す。例は`3j`、`2dw`、`4x`である。
operator前後のCountは乗算し、最大値は9,999とする。

Countを受けないapplication commandや未対応sequenceは、別の意味へ暗黙変換しない。

## 4. Normal motion

| Key                 | 動作                                       |
| ------------------- | ------------------------------------------ |
| `h/l`               | 前/次の文字またはatomic node               |
| `j/k`               | 次/前の論理行。可能な限り目標columnを維持  |
| `gj/gk`             | 次/前の画面上の表示行                      |
| `w/b/e`             | 設定されたwordの次/前/末尾                 |
| `W/B/E`             | 空白区切りWORDの次/前/末尾                 |
| `0/$`               | 論理行の先頭/末尾                          |
| `gg/G`              | 表示中のFocused Section subtreeの先頭/末尾 |
| `Ctrl-f/Ctrl-b`     | 1画面下/上                                 |
| `Ctrl-d/Ctrl-u`     | 半画面下/上                                |
| `[count]n/[count]N` | Note内検索の次/前の一致                    |

`whichwrap`がtrueの場合、Normalの`h/l/w/b/e/W/B/E`は論理行端から前後の論理行へ続く。
falseの場合は現在論理行端で止まる。Tableの同じ論理行に属するCell間移動はfalseでも許可する。

block間やSection間を移動しても、画面上にcaretが見えるようEditorをscrollする。

## 5. Insert mode

通常の文字入力と矢印keyはEditorへ渡す。IME composition中は以下のCtrl commandよりIMEを優先する。

| Key               | 動作                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `Esc / Ctrl-c`    | Normalへ戻る                                                         |
| `Ctrl-h`          | Backspace                                                            |
| `Ctrl-j / Ctrl-m` | 通常のEnterと同じ改行                                                |
| `Ctrl-u`          | 論理行先頭からcaret直前まで削除                                      |
| `Ctrl-w`          | 空白を読み飛ばし、前の設定word境界まで削除                           |
| `Ctrl-t`          | Section/ListItemを1段深くする。直接Paragraphは子Section化            |
| `Ctrl-d`          | Section/ListItemを1段浅くする。直接Paragraphは兄弟Section化          |
| `Ctrl-Enter`      | List/Table/Code/Source/Blockquoteの最外構造直後に新規Paragraphを作る |
| `Tab / Shift-Tab` | Listの階層変更、Table Cell移動など文脈依存操作                       |

`i/a`はcaret位置の前/後、`I/A`は論理行の先頭/末尾からInsertへ入る。
`o/O`は現在論理行またはblockの下/上に入力先を作る。

## 6. Operatorと編集command

| Key              | 動作                                        |
| ---------------- | ------------------------------------------- |
| `x`              | caret下からCount文字またはatomic nodeを削除 |
| `d{motion}`      | motion範囲を削除                            |
| `dd`             | Count論理行を削除                           |
| `D`              | caretから論理行末尾まで削除                 |
| `c{motion}`      | motion範囲を削除してInsertへ入る            |
| `cc`             | 論理行内容をclearし、行頭からInsertへ入る   |
| `C`              | caretから論理行末尾を変更                   |
| `S`              | 現在論理行内容を変更                        |
| `y{motion}`      | motion範囲をyank                            |
| `yy`             | Count論理行/構造をyank                      |
| `p/P`            | registerをcaretの後/前へput                 |
| `[count]r{char}` | Count文字を指定文字へ置換                   |
| `R`              | Replace modeへ入る                          |
| `J`              | 次論理行を言語境界に応じて連結              |
| `gJ`             | 空白の追加・削除をせず連結                  |
| `u`              | Undo                                        |
| `Ctrl-r`         | Redo                                        |
| `.`              | 対応する直前編集をrepeat                    |

`J`は英語どうしの境界へ空白を1つ入れ、日本語文字または日本語句読点に接する境界では空白を入れない。
`gJ`は既存文字列をそのまま連結する。

change commandによる削除と続くInsert入力は1 Undo単位にまとめる。Undo後のcaretは変更開始範囲の先頭へ戻す。
Visual yank後はselection先頭へcaretを戻す。`P`後のUndoでは、putを実行した時点のcaret位置へ戻す。

Table Cell内の`D/C/S`はCell内容だけを対象にし、Table rowを構造変更しない。

## 7. Text object

operatorと組み合わせて次を使用できる。

- `iw/aw`: 設定されたwordの内側/周囲
- `ip/ap`: Paragraphの内側/周囲

word境界は小文字motionとInsert `Ctrl-w`で共通である。Internal Linkは分割せず1 atomic単位とする。

## 8. Visual

### 8.1 Visual Char

`v`でcaret下の文字を含むVisual Charへ入る。最初の`h/l`からheadを正しく移動し、
開始文字をselectionへ含める。motion、operator、`m`によるmark変更を使用できる。

### 8.2 Visual Line

`V`で現在の論理行または構造行を選ぶ。`h/l`でcaret headは動かせるが、選択範囲は行単位のまま変えない。
`j/k`で選択する論理行を拡張・縮小する。

Paragraph、Section Header、ListItem、Code line、Table Cell、atomic blockはそれぞれの論理行境界を使う。
ListItemの選択は選択したItemまでで、未選択の子孫を暗黙に含めない。

`>/<`は選択されたSection/ListItemの階層を、表示順を維持したまま1段変更する。

### 8.3 Visual Block

Table内の`Ctrl-v`は結合CellのないTableで矩形Cell selectionへ入る。
`h/j/k/l`で矩形を変更し、`y/d/c/p/P`でcopy、clear、置換する。
通常text blockに対するVimの矩形Visual Blockは未対応である。

### 8.4 gv

`gv`は同じWindow、同じNoteで直前に使ったVisual Char、Visual Line、Visual Blockの範囲と向きを復元する。
Visual中の`gv`は現在範囲と直前範囲を交換し、続けて押すと往復できる。

文書編集で位置が残る場合は追従する。削除済み、Focused Section外、互換性を失ったTable矩形は復元せず通知する。
履歴はWindowを閉じた時またはapplication終了時に破棄し、Undoや`.`には含めない。

## 9. Table

### 9.1 motion

- Normalの`h/l`はCell内文字を移動し、Cell端ではrow-major順に前後Cellへ移る。
- `whichwrap`有効時、Table行端およびTable端から前後論理行へ移る。
- `j/k`は同じ列の前後rowへ移り、Table境界では前後論理行へ移る。
- `w/b/e/W/B/E`はCell境界と空Cellも停止位置として扱う。
- Normalの`Tab/Shift-Tab`はrow-major順に移動し、Table先頭/末尾で止まる。
- Insertの`Tab/Shift-Tab`もCell移動を行い、最終CellのTabだけは本文rowを追加する。

Table左上CellのShift-TabでEditor外やTreeへfocusを移さない。

### 9.2 編集

- Insert EnterはCell内Paragraphを分割し、Shift-EnterはHard Breakを入れる。
- Ctrl-EnterはTable全体の直後に新しいParagraphを作る。
- Table内の`p/P`は同じ動作で、現在Cellを左上として矩形またはTable dataを貼る。
- 矩形`d`はCell内容をclearし、row/column構造を維持する。
- 矩形`c`はclear後、左上CellのInsertへ入る。

`<Leader>a`のContext Actionsで、行/列の前後追加、削除、移動、列alignment、Table削除を行う。
Visual Line/Block選択中の追加数は選択row/column数と同じにする。Normalでは1行/1列である。
行/列追加は`.`のrepeat対象で、Tableの先頭rowは常にheaderである。

`/`からTableを作る場合、10×10 gridを`h/j/k/l`または矢印で選択し、選択Cellを右下とする行列数を作る。
初期値は3×3である。

### 9.3 Clipboard

矩形yankは内部Clipboard、HTML Table、GFM Markdown、TSVを同時に公開する。
Table外で矩形をputすると、headerを含むdataはそのままTableにし、本文rowだけなら空headerを補う。

## 10. Section、Link、Image

| Key             | 動作                                                |
| --------------- | --------------------------------------------------- |
| `zf/zF`         | Focused Sectionを1階層深く/浅くする                 |
| `zo/zO`         | Sectionを1段/再帰的に展開                           |
| `zc/zC`         | Sectionを1段/再帰的に折り畳む                       |
| `za/zA`         | Section foldを1段/再帰的にtoggle                    |
| `>>/<<`         | Section/ListItemを1段深く/浅くする                  |
| `gf`            | Internal Link先へ移動、または画像を現在Windowで開く |
| `Ctrl-w gf`     | 画像を新しいTabPageで開く                           |
| `gx`            | 安全な外部link/AttachmentをOS既定handlerで開く      |
| `Ctrl-o/Ctrl-i` | Window-local Jump Listを戻る/進む                   |

Internal Linkのclickはopenしない。画像を現在Windowで開いた直後の`Ctrl-o`は同じsession内の元Note/caretへ戻る。

## 11. WindowとTab

| Key              | 動作                                      |
| ---------------- | ----------------------------------------- |
| `Ctrl-w h/j/k/l` | 方向にあるWindowまたはSidebarへfocus移動  |
| `Ctrl-w s/v`     | 現在Windowを上下/左右分割                 |
| `Ctrl-w c`       | 現在WindowまたはSidebarを閉じる           |
| `Ctrl-w o`       | 現在Windowだけを残し、左右Sidebarも閉じる |
| `gt/gT`、`tn/tp` | 次/前のTabPageへ循環移動                  |
| `tc/td`          | 空TabPageを作る/現在TabPageを閉じる       |
| `t1`〜`t9`、`t0` | 1〜10番目のTabPageへ直接移動              |

最後のBufferを閉じてもTabPageを閉じず、空Bufferを表示する。最後のTabPage自体は閉じず空状態にできる。
Window分割は同じ方向に既存のsplitがあれば、それらを含めて均等化する。

## 12. Tree

TreeはEditorのVim modeではないが、共通cursor motionとCountを使用する。

| Key          | 動作                                       |
| ------------ | ------------------------------------------ |
| `[count]j/k` | 表示Treeの次/前Note                        |
| `gg/G`       | 表示Treeの先頭/末尾                        |
| `h`          | 展開Noteを閉じる。閉じていれば親へ移動     |
| `l`          | 閉じた親を展開。展開済みなら最初の子へ移動 |
| `Enter`      | 選択Noteを現在Windowで開く                 |
| `a`          | 選択Noteの次に空titleの兄弟Noteを作る      |
| `c`          | 選択Noteの子として空titleのNoteを作る      |
| `A`          | top-levelへ空titleのNoteを作る             |
| `[count]J/K` | sibling内で下/上へ並べ替える               |
| `[count]H/L` | 表示順を保って1段浅く/深くする             |
| `D`          | 選択Noteとlive子孫をTrashへ移す            |
| `T`          | Trash検索を開く                            |

Treeではmouseによるopen、並べ替え、作成、inline renameを提供しない。titleはBuffer内のRoot Headerで編集する。
`a`は選択Note直後、`c`は最後の子、`A`はtop-level末尾へ作成し、対象Windowで新Noteを開いて
空Root HeaderのInsert modeへ入る。Tree構造変更はEditor本文のUndo/Redoと`.` repeatには含めない。

## 13. Leader

既定の物理Leaderは`,`で、物理keyだけを設定変更できる。後続カテゴリは固定する。

| Key         | 動作                            |
| ----------- | ------------------------------- |
| `<Leader>a` | Editor文脈のContext Actions     |
| `<Leader>b` | load済みBuffer検索              |
| `<Leader>c` | Command Picker                  |
| `<Leader>f` | title/path検索                  |
| `<Leader>g` | 本文検索                        |
| `<Leader>o` | Outline toggle                  |
| `<Leader>s` | Note内検索                      |
| `<Leader>t` | Tree toggle                     |
| `<Leader>C` | Config / Settings（予約）       |
| `<Leader>h` | History / Recent / Jump（予約） |
| `<Leader>l` | Links / Backlinks（予約）       |
| `<Leader>n` | Note Actions（予約）            |
| `<Leader>p` | Paste / Yank History（予約）    |
| `<Leader>v` | View / Window Layout（予約）    |
| `<Leader>w` | Workspace（予約）               |
| `<Leader>y` | Yank / Export（予約）           |
| `<Leader>?` | Help / Diagnostics（予約）      |

予約keyは未実装であり、別の一時操作へ割り当てない。

## 14. 非対応または意図的差異

- 通常textに対する矩形Visual Block
- named/numbered registerの完全なVim互換
- macro記録と再生
- mark/jump command全般
- search pattern、regular expression、置換の完全なVim互換
- Vimscript、plugin mapping、Ex parser全般
- Visual Lineを使ったTable row構造操作のVim互換定義
- file間を連続textとして扱うoperator

WYSIWYG構造を破損する可能性がある操作は、textへflattenして実行せず、対応する構造commandがある場合だけ処理する。
