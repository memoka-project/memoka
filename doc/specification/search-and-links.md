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

`/`または`<Leader>s`はactive WindowのNote内検索を開く。

- 既定scopeは現在のFocused Section subtreeである。
- Root focusではNoteDoc全体を対象にする。
- queryは表示textに対する正規化済みliteral部分一致である。
- `n/N`は次/前の一致へloopし、Countを受ける。
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
- 2行目にNote Treeの祖先とNote内Section祖先をつないだ親階層を表示し、Workspace直下のRootは`/`とする。
- 階層は小さく暗いtextにする。
- 長い表示はNote titleを優先し、祖先側を省略する。
- 更新日時の新しい順にsortする。
- 時刻は現在との差を秒、分、時、日、月、年へ丸め、`10s`、`8m`のように表示する。
- file iconには`📄`を使う。

各tokenは対象titleまたはいずれかの祖先titleに一致すればよい。title自体が一致しなくても、
ancestorを含む全tokenのAND条件を満たせば結果に含める。

## 4. 本文検索

`<Leader>g`はlive Noteの直接本文を検索する。結果はNoteの更新日時が新しい順である。

各結果へ次を表示する。

- Note title
- title直後のヒット論理行番号
- 一致周辺の短い本文
- 現在からの更新時間
- Note Treeから解決した現在の祖先path

previewでは一致部分が上下中央付近に見えるようscrollし、すべての一致をhighlightする。
検索結果用pathはquery時に解決し、本文FTS rowへ`parent_path`を複製しない。

## 5. Buffer検索

`<Leader>b`、`:buffers`、`:ls`はtitle検索と同じUIを使い、現在load済みのlive Bufferへ対象を限定する。
Note Bufferは`📄`、Image Bufferは`📷`で区別する。結果を確定するとactive Windowへ選択Bufferを表示する。
独立したBuffers Sidebarは持たない。

## 6. Trash検索

`:trash`はdeleted Noteのtitle/path検索を同じpaneで開き、赤系のsemantic colorを使用する。

- `r`だけが選択Noteの復元を実行する。
- Enter/Tabは無効である。
- 復元後もpaneを閉じず、残った結果を更新する。
- Treeへ自動移動しない。
- Esc/Ctrl-cだけがpaneを閉じる。

独立したTrash Sidebarは持たない。

## 7. FTS index

Workspace検索indexはSQLite schema 8の再構築可能な派生dataである。

- titleと本文を用途別にqueryできる同一index subsystemで管理する。
- 本文は論理行と表示snippetを検索できる形で保持する。
- Note ID、Section ID、block位置、論理行番号、確定revisionを結果へ結び付ける。
- 祖先pathは保存せず、WorkspaceMetadataDocからquery時に解決する。
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
- Normal `gf`でtarget NoteDocを現在Windowへ開き、target Sectionへfocusする。
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

Jump ListはWindow-localで、`Ctrl-o/Ctrl-i`により戻る/進む。
Internal Linkの`gf`、Workspace検索結果、Outline移動、Tree/Buffer検索からの明示openを記録する。

entryはNote/Section ID、Yjs Relative Position、block ID、offset、前後context fallbackを持つ。
同じNoteの再open、失敗したopen、通常motion、Editor clickはentryを増やさない。
削除済みNoteや解決不能entryはskipする。
