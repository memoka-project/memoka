# Application UI

[仕様書へ戻る](../specification.md)

## 1. focusの原則

focusは常に利用者が操作できるsurfaceのいずれかに属する。

- Editor Window
- TreeまたはOutline Sidebar
- Command-line
- Workspace検索、Command Picker、block pickerなどのfloating pane
- application-level dialog

背景、Window内のtextがない場所、help表示、list marker付近をclickしても、focus ownerを失わない。
Windowをclickした場合はそのWindowをactiveにし、実EditorへDOM focusを同期してからkey入力を受ける。
前Windowにcaretやkey処理を残さない。

Editor canvas内のtext外をclickした場合は、同じWindow内で幾何的に近い編集可能blockまたは
atomic nodeへ解決する。最大Note幅による中央寄せで生じたcanvas外側の余白をclickした場合は、
Windowへfocusするがcaret位置を変更しない。完全な空BufferでもWindow focusだけを保持する。

## 2. focus表示

focus ownerは上端のaccent lineで識別できる。

- Editorがactiveなら、そのWindowだけをhighlightする。
- Sidebarがactiveなら、そのSidebarをhighlightし、Window highlightを消す。
- Command-lineまたはfloating paneがactiveなら、そのsurfaceをhighlightする。
- inactive Sidebarの選択行は枠だけを残し、文字色と背景のactive強調を外す。

選択Tabの上端には独立したhighlightを表示しない。Tab選択とWindow focusを混同させない。

## 3. Window statusline

Window上部にNote title専用headerを置かない。Window下端のstatuslineへ次を表示する。

- 編集可能なactive Note Window: mode、Note title、caret Sectionまでのbreadcrumb
- inactive Note Window: Note titleだけ
- 空Buffer: modeを表示せず、空title表示も置かない
- Image Buffer: filenameだけ

mode表示は太字で、Normalは青、Insertは緑、Visualは紫、Replaceは赤系にする。
Note ID、Window ID、revisionなどのdebug情報はstatuslineへ表示しない。

breadcrumbをclickすると該当Section Header先頭へcaretとscrollを移すが、Focused Sectionは変更しない。

## 4. TabPage

Application上端にcustom Tab lineを置き、OS標準title barは使用しない。

- 各TabPageは独立したWindow split treeとSidebar状態を持つ。
- 新規TabPageはSidebar非表示、1つの空Windowで開始する。
- 最後のBufferを閉じてもTabを閉じず、空Bufferを表示する。
- 最後のTabPageを閉じる操作でもApplicationを空TabPageの状態にできる。
- Tab移動は先頭/末尾でloopする。
- 最初の10 Tabには`1`〜`9`、`0`を表示し、`t1`〜`t0`で直接移動できる。
- Tabは最小幅を持たず、個数に応じて縮み、Tab lineへscrollbarを出さない。
- 追加buttonは右端Tabの隣に置き、収まらない場合だけwindow control手前の右端へ固定する。
- 追加buttonと最小化buttonの間にbutton約2個分のdrag領域を確保する。
- 右端に最小化、最大化/復元、終了buttonを置く。

## 5. WindowとBuffer

TabPage内のWindowは上下または左右へ分割できる。同じ方向に既存Windowがある場合は、
新Windowだけを50%にせず同方向の全Windowを均等化する。

Bufferは次のいずれかである。

- Note Buffer
- Image Buffer
- Empty Buffer

Windowを閉じることとBufferを閉じることを分離する。Buffer closeは参照WindowをEmpty Bufferにし、
任意の別Noteを自動表示しない。すべてのlive NoteがTrashへ移ってもEmpty Bufferを表示する。

Image BufferはAttachment IDを永続参照し、application再起動後も復元する。CAS bytesが欠損・破損していても
Buffer identityを捨てずmissing placeholderを表示する。

## 6. Sidebar

TreeとOutlineはWindowではなくSidebarであるが、focus移動、Command-line、Leader、Tab操作などの
application keyをWindowと共通に利用できる。

- close buttonや常設help textを表示しない。
- Sidebar名は下端のstatusline相当領域へ表示する。
- `Ctrl-w c`でfocused Sidebarを閉じられる。
- `Ctrl-w o`はactive Window以外のWindowと左右Sidebarを閉じる。
- Tree/Outlineの表示状態、幅、選択状態はTabPageごとに保持する。
- 新規TabPageでは非表示にする。

Sidebarが縦に長い場合はSidebar内部だけをscrollし、Tab line、statusline、Command-lineを画面外へ押し出さない。

## 7. Tree

TreeはNoteの親子構造をdepth-firstで表示する。折り畳み状態をTabPage localに保持する。
選択Noteがviewport外へ移動した場合は、Tree内部をscrollして常に表示する。

新規Noteの空titleは「新しいノート」として表示する。Tree上でrenameせず、NoteをBufferへ開いてRoot Headerを編集する。
mouse hoverだけでは選択を変更せず、Tree固有のmouse操作UIは提供しない。

## 8. Outline

Outlineはactive Windowで実際に表示しているFocused Section subtreeだけを示す。
Root表示中はNoteDoc全体、深いfocus中はそのsubtreeだけを対象にする。

- Root titleもOutlineに表示する。
- Section深さに応じてEditorと同じ循環title色を使う。
- Section番号や`§`記号を表示しない。
- EditorでfoldしたSectionは`▸`、展開中は`▾`で示す。
- foldされたSectionの子孫をOutlineでも隠す。
- Editor caretがSection間を移動したらOutline選択も追従し、内部scrollで可視にする。
- EnterまたはclickはSection Header先頭へcaretとEditor scrollを移すが、`zf`を実行しない。
- Empty Bufferでは説明textを表示しない。

## 9. 行番号

Editor左側に専用gutterを設け、論理行番号を縦に揃えて表示する。
現在行はabsoluteな論理行番号、他行は現在行からの相対値を表示し、Vimの`number + relativenumber`に合わせる。

Window幅が設定値より狭い場合はgutter全体を省略する。判定にはApplication Window全体ではなく、
個々のEditor Windowの実幅を使う。`0/off`設定では狭いWindowでも常に表示する。

BodyChunkの静的表示や大規模Markdown import後も、viewport周辺の行番号を欠落させない。

## 10. Note layout

Note canvasは設定された最大幅を超えず、広いWindow内では中央寄せにする。上限無効時はWindow幅へ追従する。
行番号gutter、本文padding、すべてのblockを含むcanvas全体を最大幅の対象にする。

共通indent幅を次へ使用する。

- 行番号境界から最初のSection guideまで
- Sectionの1階層
- Listの1階層
- Table、Code Block、Imageの左端
- List markerの基準grid

Root本文はindentせずguideを出さない。Root以外のSection titleは同じsize/styleで、親本文と同じ位置へ表示する。
Section本文と子Sectionにはdepthを示す縦guideを表示する。

List markerは深さに応じて`●、○、■、□、◆、◇`を循環する。Numbered Listはperiodの右端を縦に揃え、
桁数が増えた場合は本文側ではなく左へ伸ばす。Bullet/numberから本文までの間隔と本文開始位置は両Listで揃える。

## 11. 色とfont

Nightfox系のsemantic color tokenをApplication全体で使用する。対応themeはNightfox、Dayfox、Dawnfox、
Duskfox、Nordfox、Terafox、Carbonfoxである。

太字、斜体、inline code、打ち消し、外部link、内部link、Section title、List markerにsemantic colorを割り当てる。
Section titleはNoteからの絶対depthで色を決め、H7相当以降はpaletteを循環する。`zf/zF`しても同じSectionの色を変えない。
Visual CharとVisual Lineのselection背景は同じsemantic selection色を使う。

Application fontは本文と通常UIに適用する。code、行番号、Command-line、debug lineは等幅fontを維持する。
inline codeとCode/Source Blockは通常本文16px相当に対して13.6px相当で表示する。

## 12. development debug line

development buildだけ、Application最下部にdebug lineを表示できる。release buildではDOM、計測、表示を生成しない。

debug lineには機密contentを含めず、次の診断情報を表示できる。

- focus owner、mode、保存revisionの短い状態
- FTSのidle/waiting/running/error
- portable mirrorのwaiting/preparing/transferring/committing/errorと進捗
- keydownから対応する可視inputまたは次のDOM更新frameまでの直近値、p95、最大値、sample数、slow件数

debug line自身の更新を入力反映として計測しない。
