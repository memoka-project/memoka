# Clipboardと添付

[仕様書へ戻る](../specification.md)

## 1. Clipboardの役割

Clipboardは一時的なversion付きtransportであり、NoteDocとは別の正本ではない。
内部構造を保持できる場合は保持し、外部application向けにHTML、Markdown、plain textなどを同時に公開する。

Memoka内部MIMEは`application/x-memoka-structured-blocks+json`、schemaは7である。
payload kindはtext、block-lines、structure、section、table-cellsを持つ。

未知schema、不正なnode、invalid ID、範囲外属性はそのままNoteDocへ取り込まない。
安全に別形式へfallbackできる場合だけfallbackする。

## 2. yank時の形式

通常のyankでは、表現可能な次の形式を同じClipboard ownerから公開する。

1. Memoka内部構造
2. `text/html`
3. `text/markdown`
4. `text/plain`と`text/plain;charset=utf-8`
5. Table矩形の場合は`text/tab-separated-values`
6. Image/Attachmentだけの場合はfile Clipboard形式
7. Image 1 blockだけの場合はraster画像data

plain textはmarkを持たない。HTML/Markdownと内部形式は、対応するblock、mark、link、Table構造を保持する。

Visual Charのyankではinline Sliceを保持する。Visual Line/`yy`では論理行または構造nodeを保持する。
Section、ListItem、Table矩形、atomic blockを単なるtextとしてflattenしない。

## 3. paste形式の選択

Insert modeのnative pasteは、次の優先順位で処理する。

1. Memoka内部構造
2. 外部file path
3. raster画像data
4. Table交換形式
5. 明示的なMarkdown MIME
6. sanitized HTML
7. plain text

単一GFM Tableとして厳格にparseできるplain textだけはTable交換形式として扱う。それ以外のplain textから
Markdownらしさを一般的に推測しない。

Normalの`p/P`は通常はWorkspace内registerを使う。OS focusが戻った後にnative Clipboardを取り込む対象は、
内部MIME、外部file、raster画像data、HTML/GFM/TSV Tableである。
text registerの`p`はcaretの後、`P`は前へ貼り、貼り付け後caretは挿入した最後の文字または構造対象へ移る。
Table内では`p/P`を同じ操作として現在Cellを左上にする。

外部file/imageの非同期読込中にcaret、対象block、Note revisionが変わった場合は、古い位置へ挿入せずcancelする。

## 4. Markdown paste

`:paste-markdown`はClipboardを明示的にMarkdownとして処理する。通常位置では対応block/inlineへ変換し、
未対応領域はSource Blockとして内容を失わず保持する。

実Noteの空Root titleにcaretがあり、Root title、直接Body、子Sectionがすべて空のときだけ、
Markdown文書全体をNoteへimportする。

- 最初のblockは空でないATX H1でなければならない。
- 最初のH1 plain textを既存Root titleに設定し、Root Section IDはNote IDのまま維持する。
- 最初のH1直後から次headingまでをRoot直接Bodyにする。
- 2つ目以降のH1はRoot直下Sectionにする。
- H2〜H6は直前にある最も近い浅いheadingの子Sectionにする。
- heading levelを飛ばした場合は空Sectionを捏造せず、存在する最深ancestor直下へclampする。
- 取り込むSectionとblockへfresh UUIDv7を割り当てる。
- 全体を1 Editor/Core transaction、1 Undo単位として確定する。
- 成功後caretはRoot title末尾へ置き、末尾Sectionへ一度scrollして戻る描画を発生させない。

空Note gate内では、内部MIMEの次に`text/markdown`、Markdownとして妥当なplain text、HTMLの順に試す。
gate外ではwhole-note importせず通常paste規則を使う。

## 5. HTML paste

`:paste-html`とHTML Clipboardはallowlist sanitizerを通す。script、event handler、危険なURL、
未知の実行可能要素を除去し、対応するProseMirror node/markだけへ変換する。

HTML Tableは結合Cellを含まない矩形だけをnative Tableとして受理する。安全に変換できない領域は
silentに構造を変えず、Source Blockまたは拒否として扱う。

## 6. Attachmentデータモデル

Attachment metadataはSQLiteへ保存し、bytesはデータ領域内のSHA-256 CASへ保存する。

metadataは次を持つ。

- lowercase UUIDv7のAttachment ID
- SHA-256
- byte size
- original filename
- MIME type
- created time
- available/previewable状態

同じbytesを別の論理Attachmentとして取り込んだ場合、それぞれ別Attachment IDを持てるが、
CAS objectは同じSHA-256で共有する。Note blockはAttachment IDを参照し、filesystem pathを正本として保存しない。

blockを削除してもCAS objectを即時削除しない。参照数0の管理とCAS garbage collectionは未実装である。

## 7. import

Attachmentはfile picker、drop、OS file Clipboard、raster画像Clipboardから取り込める。

制限は次のとおりである。

- 1 file: 128 MiB以下
- 1 batch: 16 file以下
- batch合計: 512 MiB以下
- original filename: 255文字以下で、path separator、control文字、`.`、`..`を拒否
- transfer chunk: 最大4 MiB

batchはoperation IDで冪等に扱い、staging、hash検証、CAS commit、metadata commitを経て完了する。
途中失敗ではNoteへ一部blockだけを挿入しない。同じoperation IDを異なる内容で再利用しない。

PNG、JPEG、WebP、GIFはsafe rasterとしてImage blockにし、それ以外はAttachment blockにする。
MIME宣言だけを信頼せずmagic bytesも確認する。SVG、HTML/XHTML、shortcut、実行fileなどをinline imageとして扱わない。

## 8. raster画像Clipboard

LinuxではGTK image target、Windowsでは登録PNGを優先し、CF_DIBV5/CF_DIBをfallbackとして読む。
decode後、次を検証してalphaを保つPNGへ正規化する。

- width/heightが1以上32,768以下
- 総pixel数が100,000,000以下

Insert pasteとNormal `p/P`の両方でImage blockとして取り込める。Count付きputではCAS importを1回だけ行い、
同じ論理Attachmentを参照する複数Image blockを1 Undo単位で作る。

Image 1 blockだけを`yy`またはVisual Lineでyankした場合は、Linuxで`image/png`、
Windowsで登録PNGとCF_DIBV5を公開する。画像以外との混在yankでは、どの画像を代表するか曖昧なため
raster dataを公開しない。

## 9. file Clipboard

Image/Attachmentだけをyankした場合、Workspace registerを維持しながらmaterialized copyをOSへ公開する。

Linuxでは少なくとも次を同じownerから提供する。

- `text/uri-list`
- `x-special/gnome-copied-files`
- `application/vnd.portal.files`
- `application/vnd.portal.filetransfer`

WindowsではCF_HDROPを提供する。外部file managerはfile target、text editorはMarkdown/plainを選択できる。
materialized fileを外部で編集してもCAS bytesを変更せず、次回materialize時にCASから修復する。

## 10. Image block

Image blockはAttachment ID、alt text、表示幅を持つ。表示幅はNote本文幅に対する10〜100の整数percentである。
null、旧形式、範囲外値は100%として扱う。

- Normal選択またはhover時だけ外枠を画像外側に表示する。
- resize handleはhover中だけ表示する。
- drag中はDOM幅だけを更新し、pointer upで1 transaction、1 Undo単位として確定する。
- Escまたはpointer cancelでは開始幅へ戻す。
- `:image-width`は現在値を表示する。
- `:image-width 50`と`:image-width 50%`は同じ50%を設定する。
- 小数、10未満、100超、画像外での実行は拒否する。

100%は通常のMarkdown image、10〜99%は限定的な`<img src="…" alt="…" width="50%">`として
Clipboardとportable mirrorへ出力し、同じ限定形式から幅を復元する。任意HTML styleやpixel幅は受理しない。

## 11. Image BufferとAttachment open

画像上のNormal `gf`は現在WindowをImage Bufferへ置き換え、`Ctrl-w gf`は空の新しいTabPageへ開く。
画像は元寸法を超えて拡大せず、Window中央へfitする。statuslineとTabにはfilenameだけを表示し、Editor modeを持たない。

同じsessionで現在Windowを置き換えた場合、`Ctrl-o`で保存済みstable positionの元Noteへ戻る。
この一時戻り先は永続化せず、通常Jump Listの`Ctrl-i`対象にもならない。

`gx`はallowlistで安全と判定したAttachmentだけをOS既定handlerへ渡す。危険な形式、missing bytes、
不正なmaterializationはopenしない。

## 12. Markdown表現

generic Attachmentは`[label](attachment:<UUIDv7>)`、Imageは
`![alt](attachment:<UUIDv7>)`として表現する。portable mirrorではmanifestによりAttachment IDと
mirror pathを対応付け、通常表示用Markdownは相対pathへ投影する。

Markdownだけから未知のAttachment bytesを生成しない。既存Workspaceで解決できないIDはmissingとして保持する。
