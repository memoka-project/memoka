# コンテンツモデルとEditor

[仕様書へ戻る](../specification.md)

## 1. Noteの表示構造

NoteはRoot Sectionと再帰的な子Sectionで構成する。Root HeaderはNote titleとして表示し、
Root以外のHeaderはSection titleとして表示する。Section Bodyにはblockを順序付きで格納する。

Root titleが空の場合、EditorとTreeでは「新しいノート」を編集不可能な薄いplaceholderとして表示する。
Section titleが空の場合は「無題のセクション」を、そのSection深さのtitle色を薄くしたplaceholderとして表示する。
placeholder文字列は文書へ保存しない。caretを置いて入力すると空titleへ実際のtextが入る。

## 2. 対応block

現行Editorは次をnative blockとして扱う。

- Paragraph
- Bullet ListとListItem
- Numbered ListとListItem
- Code Block
- Source Block
- Table、Table Row、Table Header、Table Cell
- Blockquote
- Alert / Callout
- Details（折り畳みblock、Summaryと本文）
- Horizontal Rule
- Image
- Attachment

Section titleはHeading blockではなくSection Headerである。外部MarkdownのHeadingは、
levelと出現順に基づいてSection treeへ変換する。

Image、Attachment、Horizontal Ruleはatomic blockである。通常の文字caretを内部へ置かず、
block全体を1つの対象として選択する。

## 3. 対応inline表現

Paragraph、ListItem、Table Cellなどのinline contentで次を扱う。

- 太字
- 斜体
- 打ち消し
- inline code
- highlight
- 外部link
- Internal Section Link
- Hard Break

Visual Charでtextを選択して`m`を押すと、共通検索paneからmarkを適用できる。
太字、斜体、打ち消し、inline code、highlight、外部link、全装飾解除を提供する。
同じmarkの再適用はtoggleせず変更なしとし、確定全体を1 Undo単位にする。
取消時はVisual selectionを維持する。

Internal Section Linkはtarget Section IDを持つatomic inline nodeである。表示textは現在のNote/Section titleから
導出し、1文字ずつ編集できない。Normal caretはlink全体を覆う。clickはopenせずcaretを置き、`gf`で移動する。

## 4. 論理行

論理行はVimの行単位motion/operator、相対行番号、Visual Lineの単位である。
Window幅による自動折り返しは論理行を増やさない。

- Root/Section titleとParagraphは、block先頭、`Shift-Enter`で挿入したHard Break、block末尾を境界にする。
- ListItemは複数Blockを順序付きで保持する。内部ParagraphはHard Breakごとに論理行を分け、別Paragraph、別Block、未選択の子孫Itemを含めない。
- Code/Source Blockは保存text内の改行を境界にする。
- TableではCellのcontentを論理行として扱い、Cell境界を明示的な停止位置にする。
- atomic blockはblock全体で1論理行相当として扱う。
- DetailsはSummaryを1論理行、本文を内部blockごとの論理行として扱う。閉じた本文は通常motionの移動先から除く。

表示行motionの`gj/gk`だけは、論理行内の画面上の折り返し位置を使用する。

## 5. 通常入力とblock境界

Insert modeの通常文字、composition、矢印keyはTipTapへ渡す。構造境界のEnter、Backspace、Delete、Tabは
Memokaがblock種別に応じて処理する。

- ParagraphのEnterはParagraphを分割する。
- `Shift-Enter`は同じParagraph/Cell内へHard Breakを挿入する。
- ListItem直下のParagraphのEnterはcaret位置でItemを分割する。後続Blockと子Listは新しい兄弟Itemへ移る。単独の空ParagraphのItemではList構造を抜ける。
- ListItem内のCode/Source、Table、引用ではEnterは内部Block本来の編集操作を行う。
- `Alt-Enter`はListItem直下のParagraphをcaret位置で分割し、同じItem内に次のParagraphを作る。内部Block内では、そのBlockを包含するListItem直下のBlockの後ろに空Paragraphを作る。
- List内の`Ctrl-Enter`とNormalの`o`は内部Blockの種類によらず、caretに最も近い所有ListItemの表示順で直後に空Paragraphを持つListItemを作ってInsertで移動する。
  直接子Listがあれば最初の子Listの先頭に新しい子Itemを追加し、なければ元Itemの次の兄弟として追加する。
  元ItemのBlockをcaret位置で分割せず、既存子孫・後続Blockの親子関係・順序・IDも変えない。
  追加先のList種別と開始番号を維持し、既存の空Itemは再利用しない。変更は1 Undo単位とする。`O`とList外の`o`は従来どおり。
  ListItem registerのNormal `p`も同じ挿入位置を使い、コピーしたItem内の相対的な階層を保つ。`P`は元Itemの前のままとする。
- Table CellのEnterはCell内Paragraphを分割し、`Shift-Enter`はHard Breakを挿入する。
- Code/Source BlockのEnterはblock内へ改行を挿入する。
- List外のTable、Code/Source Block、Blockquote内の`Ctrl-Enter`は、最外側の対象構造block直後へ
  新しいParagraphを必ず作って移動する。既存Paragraphを再利用しない。
- Horizontal Rule、Image、Attachment上の`i/I`は前block末尾、`a/A`は次block先頭へ入る。
  移動先がなければ空Paragraphを作る。

Tableの詳細は[Vim操作](vim-operations.md)に記載する。

## 6. Sectionの作成と深さ

Section直下のParagraph先頭で`# `を入力すると、そのParagraph以降を直接Bodyに持つ新しい子Sectionへ変換する。
Section title以降の内容は、その新SectionのBodyまたは子Sectionになる。
Root H1からH6までを許す。H6本文での`# `はliteral textのまま残す。
深さを変える操作と全paste経路は最終treeの絶対深さを事前検証する。
H6を超える場合はtyped errorで全体を拒否し、ID、本文、revision、Undoを変更しない。
H1が複数あるMarkdownの正規化後にH6を超える場合も、平坦化やplain-text fallbackを行わない。

Section Headerでは次の操作で、明示的に選択したHeaderを1段ずつ昇格・降格する。
本文はHeaderと一緒に動く。未選択の後続Headerは、不正な深度の段差を補正する場合以外は絶対深度を維持する。
subtree全体を昇降格する場合は対象の子孫HeaderもVisual Lineで選択する。

- Insert: `Ctrl-t` / `Ctrl-d`
- Normal: `>>` / `<<`
- Visual Line: `>` / `<`

ListItem上では同じkeyをListのindent/outdentとして扱う。選択行だけに適用し、表示順を変えず、
構造上可能な項目だけを1段変更する。

Section直接BodyのParagraph上では、`Ctrl-t`または`>>`でParagraphをtitleにした最初の子Sectionを作る。
`Ctrl-d`または`<<`では現在Section直後の兄弟Sectionを作る。対象Paragraphより後ろの直接Bodyも新Sectionへ移す。
兄弟化では表示順を守るため、現在Sectionの既存子Sectionも新Sectionの配下へ移す。
titleへ変換するtextは表示文字だけとし、mark/linkを除去し、Hard Breakを空白へ変換する。

Insertの変換直後に反対方向の`Ctrl-t/Ctrl-d`を押した場合だけ、元のParagraph、mark、link、caret位置へ戻せる。
本文編集、別構造操作、Undo、Note再読込を挟むと、この一時的な逆変換情報を破棄する。
Normalの`>>/<<`はこの往復を行わず、`u`で戻す。

## 7. 構造削除、yank、put

Visual Lineは選択した論理行または構造nodeだけを対象にする。

ListItemの先頭や唯一のBlockに引用、Alert、Code/Source、Table、Image、Attachment、Horizontal Ruleも置ける。
schemaを満たすためだけの空Paragraphは挿入しない。ListItem直下の空Paragraphで`/`を入力すると共通Block pickerを開く。
Block変換と添付挿入は現在のItem内に適用し、未選択のBlockのIDや順序を変更しない。
picker確定時だけ`/`を消し、cancel時は残す。ListItem内にSectionは作らない。
ListItem内のParagraphと子Listは詰めた間隔を維持する。それ以外のBlockは先頭・末尾・唯一のBlockであっても
種類ごとの前後の余白を維持し、前後の項目やBlockと密着させない。

- 親ListItemの`dd`またはVisual Lineの`d`では、未選択の子Itemを削除しない。
  子Itemは表示位置を保つ範囲で昇格させる。
- 親ListItemを単独でyankした場合も、選択されていない子孫をClipboardへ含めない。
- `dd/yy`とVisual Lineの`d/y`は、同じItemに属する未選択のParagraphやBlockも対象にしない。残るBlockがあればItemを維持する。
- indent/outdentは所有Item単位。同じItem内の複数論理行を選択しても深さを重複変更しない。
- ListItemをVisual Lineでyank/putした場合、選択項目どうしの相対的なnest深さを維持する。
- Sectionを含むVisual Line yankでは、選択範囲に含まれるSection subtreeだけを構造として保持する。
- Section S上で`P`した構造SectionはSの子ではなく、Sの前の同じ階層へ置く。
- atomic blockの`dd/yy/p/P`はtext化せずblock構造を維持する。

## 8. Section focusとfold

Focused SectionはWindowで表示するSection subtreeを絞る機能であり、NoteDocを変更しない。

- `zf`はcaretのSectionに向かって現在focusから1階層だけ深くする。
- `zF`はcaretの深さに関係なく、現在focusから親へ1階層だけ戻す。
- どちらもcaretの文書位置を保持する。

Section foldもWindow-localな表示状態である。

- `zo/zO`: 現在Sectionを1段/再帰的に展開する。
- `zc/zC`: 現在Sectionを1段/再帰的に折り畳む。
- `za/zA`: 現在Sectionを1段/再帰的にtoggleする。
- Root Sectionもfoldできる。
- fold中はHeaderだけを表示、編集できる。
- foldされた本文もNote内検索の対象になり、一致へ移動すると必要な祖先だけを展開する。
- foldは文書Undo、Markdown、別Windowの表示へ影響しない。

## 9. Markdown拡張

CommonMark/GFMに加えて、次をimport、Clipboard、Native Markdown readで扱う。

- Obsidian形式の`==highlight==`
- GitHub AlertのNOTE、TIP、IMPORTANT、WARNING、CAUTION
- Obsidian Calloutの標準type
- 英数字、hyphen、underscoreから成るcustom Callout type
- custom title
- `[!type]+`と`[!type]-`のfold指定

CalloutのMarkdown fold指定は保持するが、Editorでは本文を常に展開して編集可能にする。
これはWindow-localなSection foldとは別の属性である。

Horizontal Ruleは選択中も線を残し、block状のselection表示を重ねる。

## 10. Slash block picker

Section直接Body、ListItem、Details本文の空ParagraphでInsert modeから`/`を入力すると共通検索paneを開く。
候補はParagraph、Bullet List、Numbered List、Code Block、Source Block、Table、Alert、
Blockquote、Horizontal Rule、Details、Image Block stub、Attachment Fileである。

- Enterで選択した型へ変更し、入力済みの`/`を削除する。
- Esc/Ctrl-cで取り消した場合は`/`を本文に残す。
- block変換はstable block IDを保ち、losslessに変換できない場合は拒否する。
- 確定後の最初のUndoは`/`へ戻し、次のUndoで`/`入力自体を戻す。
- Tableは続く10×10 gridで行列数を選ぶ。初期選択は3×3である。
- Alertは続く共通検索paneでtypeを選ぶ。

## 11. Details（折り畳みblock）

HTMLの[`details` / `summary`](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-details-element)を
本文blockとして扱う。Sectionではないため、Note tree・Section深さ・Outlineの項目を増やさない。

- `details`は`detailsSummary`と`detailsBody`を1つずつ持つ。いずれにもstable block IDを割り当てる。
- Summaryはinline textと文字装飾を保持する。空なら編集不能の薄い「詳細」を表示し、placeholderは保存しない。
- 本文は非空の`Block+`。Paragraph、List、引用、Alert、Code/Source、Table、Image、Attachment、Horizontal Rule、入れ子Detailsを許す。
- `/`の共通pickerでDetailsを選ぶと、元ParagraphをSummaryにし、空Paragraphを持つ本文を作る。作成時は開いた状態にする。
- 開閉マークのclick、Normalの`Enter` / `za`で開閉する。`zo/zc`は開く/閉じる、`zO/zC/zA`は内部Detailsも再帰的に操作する。
  Details内ではSection foldよりDetailsを優先する。閉じるとき本文にあるcaretはSummary先頭へ戻す。
- InsertのSummary上の`Enter`（`Ctrl-j/Ctrl-m`を含む）または`Shift-Enter`は本文を開いて先頭へ移る。本文のEnterは通常のblock動作を使う。
- 本文でNormalの`o`はDetails内に次の入力行を追加する。通常Paragraphでは直後に新規Paragraphを作り、本文末尾でも外へ出ない。
  Details自体がListItem内にあっても外側ListにItemを作らない。本文内のList/Code/TableではそれぞれItem/コード行/Table行を追加する。
- Details本文の通常Paragraphで`Ctrl-Enter`すると、そのDetails直後に新しいParagraphを作る。
  内部Code/Table/引用では内部blockを抜ける。ListItem内では既存List操作を優先し、先頭の子または次の兄弟Itemを作る。
- Summary上の`yy/dd`、Visual Lineの`y/d`は本文を含むDetails全体を対象にする。本文側では通常の論理行操作を使う。
- 開閉はEditor instance / Window内の表示状態であり、Yjs本文・Undo・Markdownを変更しない。Editorを再生成するとimport時の状態に戻る。
- 閉じた本文も`/`と`,g`の検索対象とし、移動先を隠しているDetailsを自動展開する。検索previewはDetails本文を展開して表示する。
- Markdown import/exportは`<details>`、`<summary>...</summary>`、空行を挟んだ本文Markdown、`</details>`で表す。
  importした`open`属性を初期状態として保持する。`name`による排他的accordionなど任意のHTML属性は取り込まない。
  Details内部のMarkdown見出しはSectionに分離せず、literalなParagraphとして保持する。
- 内部Clipboard、HTML、Markdown、Native CLI read、履歴、バックアップでも構造を保持する。

## 11. 日本語入力

IME composition中はVim commandよりIMEを優先する。composition中のEnterは変換確定としてEditorへ渡し、
改行やmode変更を実行しない。Esc/Ctrl-cも最初はcompositionを終了し、その後のkeyでNormalへ戻る。

Section title、空ListItem、空Paragraphを含むすべてのeditableで、compositionの確定textを1経路だけから反映する。
確定時に別blockへ移動したり、同じtextを二重挿入したりしてはならない。

Normal modeでIMEがONのままcommand keyを入力した場合は、IMEをOFFにして同じ物理keyをNormal commandとして
1回だけ再実行する。

Linux AppImageではhost desktop sessionのIME環境を利用する。変換候補windowの位置ずれは既知のplatform制約だが、
入力欠落、composition非表示、二重確定は許容しない。

## 12. 日本語のwordと改行候補

操作用word境界と表示用改行候補は独立して設定する。

操作の既定`fine`はBudouX文節を基礎に、長い文節を最大10書記素程度へ細分化し、
文字種境界と禁則を優先する。`budoux`は文節をそのまま使い、`unicode`は漢字、ひらがな、
カタカナ、英数字などのclass境界を使う。

`w/b/e`、operator+word motion、`iw/aw`、Insertの`Ctrl-w`は同じ設定を使う。
`W/B/E`は設定に関係なく空白区切りのWORDを使う。明示空白とblock/Cell境界は常に境界になる。
日本語を含まないtextと8,192 UTF-16 code unitを超える単一論理行ではUnicode classへfallbackする。

表示用の`fine`は同じ細分化境界、`budoux`はBudouX文節境界、`native`はbrowser標準を使う。
文書dataへ空白やzero-width文字を挿入せず、表示専用のbreak opportunityとして適用する。
inline code、Code/Source Block、8,192 UTF-16 code unitを超える単一text blockはbrowser標準で折り返す。

通常本文ではCSSの`text-autospace`を使い、CJK文字と英数字の境界へ表示上の間隔を付ける。
この間隔も文書data、検索offset、Vim word、Clipboard、Markdownには含めない。

## 13. 大規模文書

128 KiB以上または2,048行以上のplain text pasteはWorkerでParagraph列へ変換する。

- 処理中は対象Editorへの入力をlockし、進捗を表示する。
- Esc/Ctrl-cでcancelでき、cancel時は文書を変更しない。
- 完了時だけfresh block IDを持つ1 transaction、1 Undo単位として確定する。
- native Clipboardのtext payload上限は32 MiBである。
- Markdownらしさを全plain textに対して推測しない。
- 空Root titleへの文書pasteでは、先頭ATX H1のpreflightを通った場合だけNote全体Markdown importを行う。
- 大きなplain textやMarkdownを貼った後もBodyChunkにより編集可能DOM量を制限する。

大量処理、検索index、Restic capture/copy/maintenanceは入力のmain pathから分離する。
検索は確定済みrevision、backupは短時間のSQLite Online Backupで切り取った同一時点の正本を非同期に処理する。
