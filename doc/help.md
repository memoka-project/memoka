# Memoka help

**Memoka**は、Markdown記法を意識せず、Vimの操作感でノートを書ける*ローカルファースト*のノートアプリです。
編集内容は自動保存されるため、通常は保存操作を行う必要がありません。

> [!IMPORTANT]
> このノートはMemokaが管理しています。`:help`を実行するたびに、このファイルの内容から最新のHelpを作り直します。
> Helpノートへ直接加えた編集は、そのときに置き換えられます。

## 目次

- [最初に覚える](#最初に覚える)
- [Insert mode](#insert-mode)
- [移動と編集](#移動と編集)
- [Visual選択と文字装飾](#visual選択と文字装飾)
- [Sectionとblock](#sectionとblock)
- [Table編集](#table編集)
- [ノートとTree](#ノートとtree)
- [検索とlink](#検索とlink)
- [Window・Sidebar・Tab](#window・sidebar・tab)
- [Leader shortcut](#leader-shortcut)
- [Command-lineと設定](#command-lineと設定)
- [Clipboard・添付・画像](#clipboard・添付・画像)
- [データと復旧](#データと復旧)
- [このHelpについて](#このhelpについて)

## 最初に覚える

Memokaでは、文字を入力する状態と、キーで操作する状態を明確に分けます。

| Mode         | 入り方                        | 主な役割                                  |
| ------------ | ----------------------------- | ----------------------------------------- |
| Normal       | `Esc`またはInsert中の`Ctrl-c` | 移動、編集command、Window操作を行います。 |
| Insert       | `i`、`a`、`I`、`A`、`o`、`O`  | 通常の文字を入力します。                  |
| Visual Char  | `v`                           | 文字単位で範囲を選択します。              |
| Visual Line  | `V`                           | 論理行または構造単位で範囲を選択します。  |
| Visual Block | Table内の`Ctrl-v`             | Table Cellを矩形選択します。              |
| Replace      | `R`                           | 既存文字を連続して置換します。            |

Normalでは四角、Insertでは点滅しない縦棒、Replaceでは下線のcaretを表示します。
InsertからNormalへ戻ると、Insert caretの直前にある文字へNormal caretが移ります。

まずは次の操作を覚えると、ノートを書き始められます。

- `h`、`j`、`k`、`l`で移動します。
- `i`でInsertへ入り、`Esc`でNormalへ戻ります。
- `o`で現在行の下、`O`で上に新しい入力位置を作ります。
- `dd`で論理行を削除し、`yy`でコピーし、`p`または`P`で貼り付けます。
- `u`でUndoし、`Ctrl-r`でRedoします。
- `:help`を再実行すると、いつでもこのHelpを開けます。

日本語IMEの変換中は、MemokaのcommandよりIME操作を優先します。NormalでIMEがONのままcommand keyを
押した場合は、IMEをOFFにしてから同じkeyをNormal commandとして処理します。

## Insert mode

`i`と`a`はcaretの前後、`I`と`A`は論理行の先頭と末尾からInsertへ入ります。
`o`と`O`は現在の論理行またはblockの下と上に入力先を作ります。

| Key                 | 動作                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `Esc` / `Ctrl-c`    | Insertを終了してNormalへ戻ります。                                                   |
| `Ctrl-h`            | Backspaceと同じように直前を削除します。                                              |
| `Ctrl-j` / `Ctrl-m` | Enterと同じ改行を行います。                                                          |
| `Ctrl-u`            | 論理行の先頭からcaret直前までを削除します。                                          |
| `Ctrl-w`            | 空白を読み飛ばし、直前のwordを削除します。                                           |
| `Ctrl-t`            | SectionまたはListItemを1段深くします。直接本文Paragraphでは子Sectionを作ります。     |
| `Ctrl-d`            | SectionまたはListItemを1段浅くします。直接本文Paragraphでは兄弟Sectionを作ります。   |
| `Ctrl-Enter`        | List、Table、Code Block、Source Block、Blockquoteの直後に新しいParagraphを作ります。 |
| `Tab` / `Shift-Tab` | Listの階層変更やTable Cell移動など、現在の構造に応じた操作を行います。               |

### `/`によるblock作成

空のParagraphで`/`を入力すると、block typeの選択画面が開きます。文字を入力して候補を絞り、
矢印keyで選択して`Enter`で確定します。`Esc`または`Ctrl-c`で取り消すと、入力した`/`は本文に残ります。

Tableを選ぶと10×10のgridが開きます。`h`、`j`、`k`、`l`または矢印keyで右下Cellを選び、
`Enter`で行数と列数を確定します。初期選択は3×3です。Alertを選んだ場合は、続く画面で
GitHubまたはObsidian互換のAlert typeを選択します。

### 日本語のwordと折り返し

小文字の`w`、`b`、`e`、wordを使うoperator、`iw`、`aw`、Insertの`Ctrl-w`は、同じword境界を使います。
既定の`fine`はBudouXの文節を基礎に、長い文節を細かく分割します。`budoux`は文節をそのまま使い、
`unicode`は漢字、ひらがな、カタカナ、英数字などの文字種で分けます。大文字の`W`、`B`、`E`は、
この設定に関係なく空白区切りのWORDを使います。

表示上の日本語の折り返しはword操作とは別に設定できます。どちらの設定も文書データへ空白や
ゼロ幅文字を追加しません。

## 移動と編集

### 移動

| Key                     | 動作                                                      |
| ----------------------- | --------------------------------------------------------- |
| `[count]h/j/k/l`        | 文字または論理行を移動します。                            |
| `gj` / `gk`             | 画面上で折り返された表示行を上下に移動します。            |
| `w` / `b` / `e`         | 設定されたwordの次、前、末尾へ移動します。                |
| `W` / `B` / `E`         | 空白区切りWORDの次、前、末尾へ移動します。                |
| `0` / `$`               | 論理行の先頭、末尾へ移動します。                          |
| `gg` / `G`              | 表示中のFocused Section subtreeの先頭、末尾へ移動します。 |
| `Ctrl-f` / `Ctrl-b`     | 1画面ぶん下、上へ移動します。                             |
| `Ctrl-d` / `Ctrl-u`     | 半画面ぶん下、上へ移動します。                            |
| `[count]n` / `[count]N` | ノート内検索の次、前の一致へ移動します。                  |

`whichwrap = true`では、`h/l/w/b/e/W/B/E`が論理行端を越えて前後の論理行へ移動します。
`false`では論理行端で停止します。

### 編集

| Key                | 動作                                              |
| ------------------ | ------------------------------------------------- |
| `x`                | caret下から文字またはatomic nodeを削除します。    |
| `d{motion}`        | motionで指定した範囲を削除します。                |
| `dd`               | 論理行または構造単位を削除します。                |
| `D`                | caretから論理行末尾までを削除します。             |
| `c{motion}`        | 範囲を削除してInsertへ入ります。                  |
| `cc`               | 論理行の内容をclearし、行頭からInsertへ入ります。 |
| `C`                | caretから論理行末尾までを変更します。             |
| `S`                | 現在の論理行内容を変更します。                    |
| `y{motion}` / `yy` | 文字範囲または論理行・構造をyankします。          |
| `p` / `P`          | registerの内容をcaretの後、前へputします。        |
| `[count]r{char}`   | caret下から指定数の文字を1文字で置換します。      |
| `R`                | Replace modeへ入ります。                          |
| `J` / `gJ`         | 次の論理行を連結します。                          |
| `u` / `Ctrl-r`     | Undo、Redoを行います。                            |
| `.`                | 対応している直前の編集を繰り返します。            |

数字をcommandの前へ付けると、対応する操作を繰り返せます。たとえば`3j`、`2dw`、`4x`のように入力します。
operatorの前後にあるcountは乗算され、最大値は9,999です。

`J`は英語どうしの境界に空白を1つ入れますが、日本語または日本語の句読点に接する境界には空白を
入れません。`gJ`は空白を追加も削除もせず、そのまま連結します。

### Text object

- `iw` / `aw`はwordの内側、周囲を選びます。
- `ip` / `ap`はParagraphの内側、周囲を選びます。

たとえば`ciw`は現在のwordを変更し、`yap`は現在のParagraphをyankします。Internal Linkは分割せず、
全体を1つのatomic unitとして扱います。

## Visual選択と文字装飾

### Visual Char

`v`はcaret下の文字を含む文字選択を開始します。motionで範囲を変更し、`y`、`d`、`c`などを実行できます。
選択後に`m`を押すと共通検索paneが開き、斜体、太字、打ち消し、inline code、highlight、外部link、
全装飾解除を選べます。同じ装飾を再度選んだ場合はtoggleせず、変更なしになります。

### Visual Line

`V`は現在の論理行または構造行を選択します。`j`と`k`で選択行を増減します。`h`と`l`でheadの
caretは移動しますが、選択範囲は論理行単位のままです。ListItemでは、実際に選択したItemだけを対象にし、
未選択の子孫を暗黙に含めません。

Section titleまたはListItemを選んで`>`、`<`を押すと、表示順を保ちながら1段深く、浅くします。

### Visual Block

Table内の`Ctrl-v`は、Cellを矩形選択するTable専用Visual Blockを開始します。`h/j/k/l`で矩形を変更し、
`y/d/c/p/P`でcopy、clear、置換を行います。通常のtext blockに対する矩形Visual Blockは未対応です。

### 直前の選択を復元する

`gv`は、同じWindowとNoteで直前に使ったVisual Char、Visual Line、Visual Blockを復元します。
Visual中に`gv`を押すと、現在の選択と直前の選択を交換できます。削除済み、Focused Section外、
互換性を失ったTable矩形は復元せず、理由を通知します。

## Sectionとblock

NoteのタイトルはRoot Sectionのタイトルです。空の場合は**新しいノート**、通常Sectionが空の場合は
**無題のセクション**という薄いplaceholderを表示します。placeholderは保存、copy、検索の対象になりません。

### Sectionの移動と階層

| Key                         | 動作                                                |
| --------------------------- | --------------------------------------------------- |
| `zf`                        | caretがある方向へFocused Sectionを1階層深くします。 |
| `zF`                        | 現在のFocused Sectionから親へ1階層戻ります。        |
| `>>` / `<<`                 | SectionまたはListItemを1段深く、浅くします。        |
| Visual Lineの`>` / `<`      | 選択したSectionまたはListItemの階層を変更します。   |
| Insertの`Ctrl-t` / `Ctrl-d` | 入力中のSectionまたはListItemの階層を変更します。   |

Section直下のParagraphで`>>`またはInsertの`Ctrl-t`を使うと、そのParagraphをタイトルにした子Sectionを
作ります。`<<`またはInsertの`Ctrl-d`では兄弟Sectionを作ります。Paragraphより後ろの本文も新しいSectionへ
移動します。Normal操作は`u`、Insert直後の逆方向操作は一時的な逆変換で元へ戻せます。

### Sectionの折り畳み

| Key         | 動作                                     |
| ----------- | ---------------------------------------- |
| `zo` / `zO` | 現在Sectionを1段、再帰的に展開します。   |
| `zc` / `zC` | 現在Sectionを1段、再帰的に折り畳みます。 |
| `za` / `zA` | 現在Sectionを1段、再帰的にtoggleします。 |
| `Enter`     | `za`と同じく現在Sectionをtoggleします。  |

折り畳み中はSection titleだけを表示、編集できます。折り畳み状態はWindowごとの表示状態であり、本文や
Undo履歴へは保存しません。折り畳んだ本文も`/`検索の対象になり、一致へ移動すると必要な祖先だけを展開します。

### 構造blockから本文へ戻る

List、Table、Code Block、Source Block、Blockquote内で`Ctrl-Enter`を押すと、その最外構造の直後へ
新しいParagraphを作って移動します。直後に既存Paragraphがあっても再利用しません。

Horizontal Rule上では、`i`と`I`が前block末尾、`a`と`A`が次block先頭へ入ります。移動先がない側には
新しいParagraphを作ります。

## Table編集

### Cell間を移動する

- Normalの`h`と`l`はCell内を移動し、Cell端ではTabと同じrow-major順で前後Cellへ進みます。
- `whichwrap`が有効なら、Table先頭と末尾から前後の論理行へ移動します。
- `j`と`k`は同じ列の前後rowへ移動し、Table境界では前後の論理行へ移動します。
- `w/b/e/W/B/E`は空Cellを飛ばさず、Cell境界を停止位置として扱います。
- Normalの`Tab`と`Shift-Tab`はTable先頭と末尾で止まります。
- Insertの`Tab`と`Shift-Tab`もCellを移動し、最終Cellで`Tab`を押した場合だけ本文rowを追加します。
- 左上Cellの`Shift-Tab`でEditor外やTreeへfocusを移しません。

Insertの`Enter`はCell内に新しいParagraphを作り、`Shift-Enter`は同じParagraph内へHard Breakを入れます。
`Ctrl-Enter`はTable全体の直後へ新しいParagraphを作ります。

Table内の`p`と`P`は同じ動作で、現在Cellを左上として矩形またはTable dataを貼り付けます。
Visual Blockの`d`はCell内容だけをclearし、rowとcolumnは残します。`c`はclear後に左上CellのInsertへ入ります。

`<Leader>a`のContext Actionsでは、rowとcolumnの追加、削除、移動、alignment変更、Table削除を行えます。
Visual LineまたはVisual Blockで複数row、columnを選択している場合は、選択数と同じ数を追加します。
rowとcolumnの追加は`.`で繰り返せます。

## ノートとTree

`<Leader>t`または`:tree`でTreeを開きます。Treeはkeyboard操作を前提とし、mouseによるopen、並べ替え、
作成、inline renameは行いません。タイトルはNoteを開き、EditorのRoot titleで編集します。

| Key                     | 動作                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `[count]j` / `[count]k` | 表示中の次、前のNoteを選択します。                           |
| `gg` / `G`              | 表示Treeの先頭、末尾へ移動します。                           |
| `h`                     | 展開中のNoteを閉じます。閉じている場合は親へ移動します。     |
| `l`                     | 閉じた親を展開します。展開済みの場合は最初の子へ移動します。 |
| `Enter`                 | 選択Noteを現在Windowで開きます。                             |
| `a`                     | 選択Noteの直後に空タイトルの兄弟Noteを作ります。             |
| `c`                     | 選択Noteの最後の子として空タイトルのNoteを作ります。         |
| `A`                     | top-level末尾に空タイトルのNoteを作ります。                  |
| `[count]J` / `[count]K` | 同じ親の中で下、上へ並べ替えます。                           |
| `[count]H` / `[count]L` | 表示順を保ちながら1段浅く、深くします。                      |
| `D`                     | 選択Noteとliveな子孫をTrashへ移します。                      |
| `T`                     | Trash検索を開きます。                                        |
| `Esc`                   | Treeを閉じてactive Windowへ戻ります。                        |

Treeの構造変更はEditor本文のUndo、Redo、`.`には含まれません。`:trash`では削除済みNoteを検索し、
`r`で復元します。`Enter`と`Tab`では閉じず、`Esc`または`Ctrl-c`で終了します。

## 検索とlink

### Note内検索

Normalの`/`または`<Leader>s`で、現在のFocused Section subtreeを検索します。Rootを表示している場合は
Note全体が対象です。`Enter`、`Esc`、`Ctrl-c`で検索入力を閉じ、`[count]n`と`[count]N`で次、前の一致へ
循環移動します。外部linkは表示されているlink textだけを検索し、URL自体は対象にしません。

### Workspace検索

| Key         | 対象                                  |
| ----------- | ------------------------------------- |
| `<Leader>f` | Section titleと祖先pathを検索します。 |
| `<Leader>g` | Sectionの直接本文を検索します。       |
| `<Leader>b` | 読み込み済みBufferを検索します。      |

空白で区切った語はAND条件になります。検索paneでは入力欄にfocusしたまま文字を入力でき、矢印keyまたは
`Ctrl-p`と`Ctrl-n`で結果を選びます。`Enter`または`Tab`で開き、`Esc`または`Ctrl-c`で取り消します。

### Internal Linkと外部link

Insertで`[[`を入力するとInternal Link候補が開きます。Internal Linkは表示上1文字として扱い、link titleを
直接編集しません。Normalの`gf`で対象Sectionへ移動し、`Ctrl-o`で移動元、`Ctrl-i`で移動先へ戻れます。
clickはlinkを開かず、caretを置くだけです。

外部linkはVisual Charで文字を選び、`m`から設定します。link上にcaretがある間はstatuslineへURLを表示します。
Normalの`gx`は安全なabsolute URLだけをOSへ渡します。相対URLは保存できますが、`gx`では開きません。

## Window・Sidebar・Tab

### Window

| Key                     | 動作                                             |
| ----------------------- | ------------------------------------------------ |
| `Ctrl-w h/j/k/l`        | 指定方向のWindowまたはSidebarへfocusを移します。 |
| `Ctrl-w s` / `Ctrl-w v` | 現在Windowを上下、左右に分割します。             |
| `Ctrl-w c`              | 現在WindowまたはSidebarを閉じます。              |
| `Ctrl-w o`              | 現在Windowだけを残し、左右Sidebarも閉じます。    |

同じ方向へWindowを追加すると、その方向に並ぶWindowを均等に分割します。最後のBufferを閉じてもWindowや
Tabは閉じず、空Bufferを表示します。

### SidebarとOutline

- `<Leader>t`はTree、`<Leader>o`はOutlineをtoggleします。
- Sidebarにfocusがあるときも、`:`、Leader、Tab、Windowの操作を利用できます。
- Outlineはactive Windowに現在表示しているSectionだけを示します。
- Outlineの`Enter`はSectionをfocusせず、対象title先頭へEditor caretを移動します。
- Editor caretが別Sectionへ移ると、Outlineの選択とscrollも追従します。
- Sectionの折り畳みはOutlineにも反映されます。

### Tab

| Key               | 動作                             |
| ----------------- | -------------------------------- |
| `gt` / `tn`       | 次のTabへ循環移動します。        |
| `gT` / `tp`       | 前のTabへ循環移動します。        |
| `tc`              | 空Bufferを持つTabを作ります。    |
| `td`              | 現在Tabを閉じます。              |
| `t1`〜`t9` / `t0` | 1〜10番目のTabへ直接移動します。 |

最後のTab自体は閉じず、空の状態にできます。

## Leader shortcut

既定Leaderは`,`です。`config.toml`では物理Leader keyだけを変更でき、その後に続くcategory keyは固定です。
予約済みのkeyは未実装であり、別の一時的な操作には割り当てません。

| Key         | Category                | 状態     |
| ----------- | ----------------------- | -------- |
| `<Leader>a` | Context Actions         | 利用可能 |
| `<Leader>b` | Buffer Search           | 利用可能 |
| `<Leader>c` | Command Picker          | 利用可能 |
| `<Leader>f` | Title Search            | 利用可能 |
| `<Leader>g` | Body Search             | 利用可能 |
| `<Leader>o` | Outline                 | 利用可能 |
| `<Leader>s` | Note Search             | 利用可能 |
| `<Leader>t` | Tree                    | 利用可能 |
| `<Leader>C` | Config / Settings       | 予約済み |
| `<Leader>h` | History / Recent / Jump | 予約済み |
| `<Leader>l` | Links / Backlinks       | 予約済み |
| `<Leader>n` | Note Actions            | 予約済み |
| `<Leader>p` | Paste / Yank History    | 予約済み |
| `<Leader>v` | View / Window Layout    | 予約済み |
| `<Leader>w` | Workspace               | 予約済み |
| `<Leader>y` | Yank / Export           | 予約済み |
| `<Leader>?` | Help / Diagnostics      | 予約済み |

## Command-lineと設定

NormalまたはSidebarなどのapplication surfaceで`:`を押すと、画面下部にCommand-lineが開きます。
`Enter`で実行し、`Esc`または`Ctrl-c`で取り消します。`<Leader>c`ではcommandを検索して選べます。
MemokaのCommand-lineは完全なVim Ex parserではありません。

| Command                                           | 動作                                                |
| ------------------------------------------------- | --------------------------------------------------- |
| `:tree`                                           | Treeを開きます。                                    |
| `:trash`                                          | Trash内のNoteを検索します。                         |
| `:buffers` / `:ls`                                | 読み込み済みBufferを検索します。                    |
| `:outline`                                        | 現在WindowのOutlineを開きます。                     |
| `:split` / `:sp`                                  | 現在Windowを上下に分割します。                      |
| `:vsplit` / `:vs`                                 | 現在Windowを左右に分割します。                      |
| `:close` / `:clo`                                 | 現在Windowを閉じます。                              |
| `:bdelete` / `:bd`                                | 現在Bufferを閉じ、Windowを空にします。              |
| `:tabnew`                                         | 空のTabを作ります。                                 |
| `:tabclose` / `:tabc`                             | 現在Tabを閉じます。                                 |
| `:tabnext` / `:tabn`                              | 次のTabへ移動します。                               |
| `:tabprevious` / `:tabp`                          | 前のTabへ移動します。                               |
| `:paste-markdown`                                 | ClipboardをMarkdownとして貼り付けます。             |
| `:paste-html`                                     | ClipboardをHTMLとして貼り付けます。                 |
| `:attach`                                         | file pickerから現在位置へ添付します。               |
| `:image-width [10..100%]`                         | 現在画像の表示幅を確認、変更します。                |
| `:switch-workspace`                               | 別のWorkspaceデータ領域へ切り替えます。             |
| `:update`                                         | 署名済み更新を確認、適用します。                    |
| `:version` / `:ver`                               | Memoka、Tauri、OS、architectureを表示します。       |
| `:diagnostics` / `:diag`                          | 診断情報とlog directoryを表示します。               |
| `:colorscheme [name]` / `:colo`                   | Nightfox themeを選択、変更します。                  |
| `:font`                                           | Application全体のfontを選択します。                 |
| `:zoom [50..200]`                                 | Zoomを確認、変更します。                            |
| `:note-width [px/off]`                            | Noteの最大表示幅を確認、変更、解除します。          |
| `:line-number-min-width [px/off]`                 | 行番号を表示するWindow最小幅を確認、変更します。    |
| `:indent-width [16..64]`                          | SectionとListに共通するindent幅を確認、変更します。 |
| `:word-segmentation [mode]` / `:word-segment`     | 日本語word分割を確認、変更します。                  |
| `:line-break-segmentation [mode]` / `:line-break` | 日本語の表示上の改行を確認、変更します。            |
| `:quit` / `:q` / `:qa`                            | 保存と必要なmirror生成を終えてMemokaを終了します。  |
| `:help`                                           | この管理Help Noteを同期して開きます。               |

### `config.toml`

設定fileはOSのapplication config directoryにある`config.toml`です。物理Leader、共通cursor移動、
Tree、Visual Charの文字装飾、Tableの移動とVisual Block開始keyを変更できます。未知または不正な設定が
ある場合はwarningを表示し、安全な既定値へ戻します。

主な設定値は次のとおりです。

- `theme`はNightfox、Dayfox、Dawnfox、Duskfox、Nordfox、Terafox、Carbonfoxから選びます。
- `font_family`は通常UIと本文のCSS font-familyです。
- `zoom_percent`は50〜200の10%刻みです。
- `note_max_width_px`はNote canvasの最大幅で、`0`は上限なしです。
- `line_number_min_width_px`より狭いWindowでは行番号を隠します。`0`は常時表示です。
- `indent_width_px`はSection、List、Table、Code Block、Imageに共通する表示grid幅です。
- `vim.whichwrap`は対応motionが論理行端を越えるかを指定します。
- `japanese.word_segmentation`と`japanese.line_break_segmentation`は操作と表示の日本語分割を個別に指定します。
- `shutdown.wait_for_mirror = false`では、終了時にmirror完成を待たず、次回起動後へ生成を回します。既定は`true`です。

## Clipboard・添付・画像

`y`や`yy`は、可能な場合にMemoka内部構造、HTML、Markdown、plain textを同時にOS Clipboardへ公開します。
`p`はcaretの後、`P`は前へ貼り付けます。Table内では`p`と`P`が同じ動作になり、現在Cellから貼り付けます。

外部fileはfile picker、drop、Insertのpaste、Normalの`p/P`で取り込めます。安全なraster画像はImage、
その他はAttachment blockになります。画像dataだけをClipboardへcopyした場合もPNG Imageとして取り込めます。

画像1 blockだけをyankすると、Markdownやfile形式に加えてOSの画像dataも公開します。画像と他blockを
一緒にyankした場合は、曖昧な画像dataを公開しません。

画像を選択またはhoverするとresize handleを表示します。dragで幅を変更でき、`:image-width 50`または
`:image-width 50%`でもNote表示幅の50%にできます。画像上の`gf`は現在Window、`Ctrl-w gf`は新しいTabで
画像を開きます。同じsession中は`Ctrl-o`で元のNote位置へ戻れます。Attachment上の`gx`は、安全な形式だけを
OS既定applicationへ渡します。

## データと復旧

初回起動時にWorkspaceのデータ領域を選択します。内部データはその中の`.memoka`へ保存され、人間が読める
Markdown mirrorはデータ領域直下へ自動出力されます。これをportable mirrorと呼びます。mirrorは外部で
編集してMemokaへ読み戻すための第二の編集データではありません。世代管理が必要な場合は、外部のbackup toolを
使用してください。

終了時は既定でmirrorの完成を待ちます。別のデータ領域へ移るときは`:switch-workspace`を使います。
同じWorkspaceを別processで開こうとすると新しいprocessは終了し、既存Windowを前面へ戻します。

復旧前に専用CLIでmirrorを検証し、空のデータ領域へrestoreできます。

```text
memoka-cli verify --source <portable-mirror-data-area>
memoka-cli restore --source <portable-mirror-data-area> --target <empty-data-area>
```

## このHelpについて

このHelpの原稿は、Memoka source repositoryにある`doc/help.md`です。`:help`はそのMarkdownを通常の
Memoka Noteとして取り込み、同じ管理Noteを最新内容へ同期します。

問題報告とsource codeは[memoka-project/memoka](https://github.com/memoka-project/memoka)を参照してください。
