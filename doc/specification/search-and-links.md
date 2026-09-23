# 検索とリンク

[仕様書へ戻る](../specification.md)

## 1. 共通検索pane

Workspace検索、Buffer検索、Trash、Command Picker、block/mark pickerは共通のfloating paneを使用する。
Application Window中央に表示し、左側を結果一覧と1行query、右側をpreviewとする。

- 検索中のfocusはquery入力に置き、文字をそのまま入力する。
- query右端に結果件数を表示する。
- pane上部へ検索種別titleや不要な案内文を表示しない。
- 結果件数でpaneの縦sizeを変えない。
- 結果は下から上へ並べ、開始時は最下項目を選択する。
- 上下矢印で選択し、選択行が常に一覧viewport内へ入るようscrollする。
- mouse hoverでは選択を変えず、clickで選択する。
- Esc/Ctrl-cで閉じる。
- queryはUnicode正規化後、空白区切りtokenのAND条件として扱う。
- 一致文字列を結果とpreviewで背景highlightする。

## 2. Note内検索

`/`または`<Leader>s`は前方、`?`は後方のactive WindowのNote内検索を開く。入力欄のpromptは開いた方向を表示する。

- 既定scopeは現在のFocused Section subtreeである。
- Root focusではNoteDoc全体を対象にする。
- 1〜128文字で先頭がASCII小文字、残りがASCII小文字か`-`のqueryを`Enter`で確定すると、Focused Section subtree全体のword候補を
  Migemo＋fzf型あいまい検索し、現在位置から指定方向の次の一致へ移動する。画面内にhintがなくても検索できる。
  以後の`n/N`はこのqueryの候補を最後の検索方向に従って巡回する。
- 先頭がASCII小文字で残りがASCII小文字か`-`のqueryを入力中は、active Editorの表示範囲にあるword候補へfzf型のあいまい照合と
  Migemoのローマ字・日本語照合を行う。同じwordの重複を除き、最良の一致箇所へ大文字1〜3文字のprefix-freeな
  hintを表示する。hintは文書へ書き込まず、画面外や折り畳み中の候補には表示しない。
- hint labelを確定すると一致箇所へ移動する。Window-localな検索状態には小文字queryと最後の`/`または`?`の方向を保存し、
  `n/N`は同じFocused Section subtreeのword候補をその方向に従って巡回する。折り畳み本文も巡回対象である。
- hint入力中の`Enter`は入力欄の全文を従来の正規化済みliteral部分一致へ渡す。先頭の大文字、
  hint prefixに該当しない大文字、または上記のquery形式から外れる入力も従来検索入力へ移り、
  `Enter`まで編集を続けられる。Migemo辞書を読み込めない場合も従来検索を使う。
  一致しなくてもエラーを通知して検索入力を閉じ、Normalへ戻る。
  IME確定中の`Enter`では検索を実行しない。
- Migemo辞書はアプリに同梱してオフラインで読む。読み込み失敗時はhintを停止してエラーを示し、
  従来検索と前回の有効な検索状態を保持する。
- `n/N`は直前の`/`または`?`と同方向/逆方向の一致へloopし、Countを受ける。`N`で基準方向は変えない。
- Command-lineへ総一致数と現在位置を表示し、`n/N`ごとに即時更新する。
- 一致移動は事前計算した位置indexを利用し、毎回Note全体のDOM走査を行わない。
- fold中のcontentも検索し、移動時は一致を含む必要最小限の祖先Sectionを展開する。
- Enter/Esc/Ctrl-cで検索入力を抜けたらIMEをOFFにする。

外部linkは表示labelだけを検索対象にし、画面に表示しないURLを一致対象にしない。
Internal Linkも現在表示されるtitle textを対象にし、atomic node全体へcaretを置く。
一致位置を表示できないhidden attributeへ移動して検索を停止させてはならない。

## 3. title検索

`<Leader>f`はlive NoteDocにあるRoot/Section titleと祖先pathを検索する。Root titleはNote titleであり、
非Root titleも独立した検索結果になる。

- 1行目に一致したRoot/Section titleを表示する。
- titleの下に更新日時とNamespace祖先（グループを含む）・Note内Section祖先をつないだ親階層を補助行として表示し、Workspace直下のRootは`/`とする。
- 階層は小さく暗いtextにする。
- 長い表示はNote titleを優先し、祖先側を省略する。
- 更新日時の新しい順にsortする。
- 更新日時は`YYYY/MM/DD HH:mm:ss (8m ago)`のように絶対日時と経過時間を常時併記し、狭い幅では折り返す。
- file iconには`📄`を使う。

各tokenは対象titleまたはいずれかの祖先titleに一致すればよい。title自体が一致しなくても、
ancestorを含む全tokenのAND条件を満たせば結果に含める。

## 4. 本文検索

`<Leader>g`はlive Noteの直接本文を検索する。結果はNoteの更新日時が新しい順である。

各結果へ次を表示する。

- Note title
- title直後のヒット論理行番号
- 一致周辺の短い本文
- 更新日時と現在からの経過時間（title検索と同じ日時部品）
- Note Treeから解決した現在の祖先path

previewでは一致部分が上下中央付近に見えるようscrollし、すべての一致をhighlightする。
検索結果用pathはquery時に解決し、本文FTS rowへ`parent_path`を複製しない。

## 5. Buffer検索

`<Leader>b`、`:buffers`、`:ls`はtitle検索と同じUIを使い、現在load済みのlive Bufferへ対象を限定する。
Note Bufferは`📄`、Image Bufferは`📷`で区別する。結果を確定するとactive Windowへ選択Bufferを表示する。
独立したBuffers Sidebarは持たない。

## 6. Trash検索

`:trash`はdeleted Noteとグループのtitle/path検索を同じpaneで開き、赤系のsemantic colorを使用する。
グループは`📁`で表示し、存在しないNote/Sectionのpreviewを生成しない。

- `r`だけが選択EntryのTrash operationをまとめて復元する。
- Enter/Tabは無効である。
- 復元後もpaneを閉じず、残った結果を更新する。
- Treeへ自動移動しない。
- Esc/Ctrl-cだけがpaneを閉じる。

独立したTrash Sidebarは持たない。

## 7. FTS index

Workspace検索indexはschema 10の再構築可能なSQLite派生dataである。
ListItemを1行へ集約せず、内部Blockを表示順に走査する。ParagraphのHard Breakは個別行として索引化し、
内部ParagraphのBlock ID、行index、UTF-16 offsetを検索結果と移動先で共有する。旧indexはbackgroundで再構築する。

- titleと本文を用途別にqueryできる同一index subsystemで管理する。
- 本文は論理行と表示snippetを検索できる形で保持する。
- Note ID、Section ID、block位置、論理行番号、確定revisionを結果へ結び付ける。
- 祖先pathは保存せず、WorkspaceMetadataDocからquery時に解決する。
- Namespace/Sectionの名前と親IDだけを持つ派生graphからpathを解決する。グループ名を本文FTSへ混入させない。
- parent変更や祖先renameだけでは子孫本文rowを更新せず、子孫`updated_at`も変更しない。
- 確定Noteの変更だけをdebounce/coalesceして非同期indexingする。
- 本文index更新はNoteごとに約1秒debounceし、検索入力は75 ms trailing debounceする。
- 構造previewは選択が150 ms安定してから生成し、同じNoteのEditorを再利用する。
- 同じNoteの古いqueue itemは最新revisionへまとめる。
- indexが未初期化、古いschema、破損の場合はUIをblockせず再構築する。
- FTSが一時利用不能な場合はCRDT searchへfallbackできるが、通常状態を恒常的なwarningとして表示しない。

検索はEditorの可視DOMではなく、Coreが確定したNote state/indexを使う。静的BodyChunkやfoldによって結果を失わない。

## 8. Internal Section Link

Insert modeで`[[`を入力すると、Section title候補を共通検索paneで表示する。
選択するとtarget Section IDを持つatomic Internal Linkを挿入する。

- link textはtargetの現在titleから導出する。
- Note/Section renameはすべての表示へ反映するが、link target IDは変えない。
- link内の1文字単位編集、`h/l`移動を許さない。
- clickはlink先を開かずcaretを置く。
- Normal `gf`でtarget NoteDoc全体を現在Windowへ開き、focusを解除してtarget Sectionタイトル先頭へ移動する。タイトルがWindow上部になるようスクロールして本文を表示する（末尾付近ではスクロール可能な範囲まで）。
- 移動前位置をWindow-local Jump Listへ追加する。
- target欠損時は文書を変更せず通知する。

既存Internal Linkのtargetを別IDへ変更する本文commandは実装していない。

## 9. 外部link

外部linkはVisual Char selectionから`m`のLink操作で設定する。
bare domainは安全なabsolute URLへ正規化し、scheme/URLをvalidationする。

- clickはopenせずcaretを置く。
- active caretまたはVisual headがlink上にある間、statusline右端へ完全なURLを表示する。
- 長いstatusline表示は省略できるが、hover tooltipでも完全なURLを確認できる。
- `gx`だけがabsoluteで許可されたURLをOS既定handlerへ渡す。
- relative URL、危険なscheme、invalid URLはopenしない。

Note内検索はURLではなく表示labelを対象にする。

## 10. Jump List

本文のJump ListはWindow-localで、`Ctrl-o/Ctrl-i`により戻る/進む。
Internal Linkの`gf`、Workspace検索結果、Outline移動、Tree/Buffer検索からの明示openを記録する。

entryはNote/Section ID、Yjs Relative Position、block ID、offset、前後context fallbackを持つ。
単独の`gg/G`・`H/M/L`、count付き`zt/zz/zb`で位置が変わった場合も移動前位置を記録する（operatorの一部は除く）。
同じNoteの再open、失敗したopen、その他の通常motion、scroll、Editor click、focus移動はentryを増やさない。
削除済みNoteや解決不能entryはskipする。

Tree/OutlineにはTabPage内でそれぞれ独立したJump Listを持ち、本文と共有しない。同じjump motionを記録し、`[count]Ctrl-o/i`で戻る/進む。
TreeのentryはEntry ID、Outlineは表示NoteごとのSection ID。削除済み項目はskipし、foldに隠れた項目は最寄りの表示祖先へ復元する。
Outlineは表示Note変更時にresetし、Focused Section subtree外の履歴はskipする。
最大100件、新しいjumpでforward履歴を破棄する。同位置・失敗は記録しない。Sidebarを閉じても保持し、TabPage close/アプリ終了で破棄する。永続化はしない。
