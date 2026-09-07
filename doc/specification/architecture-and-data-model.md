# アーキテクチャとデータモデル

[仕様書へ戻る](../specification.md)

## 1. データの分類

| 分類           | 内容                                                          | 再構築               |
| -------------- | ------------------------------------------------------------- | -------------------- |
| 内部正本       | WorkspaceMetadataDoc、NoteDoc、Attachment metadata、CAS bytes | 不可                 |
| 永続補助       | revision、snapshot、update log、migration backup              | 正本の一部として保護 |
| 派生data       | FTS index、title cache、履歴preview、materialized file        | 正本から可能         |
| local UI state | Tab、Window、Buffer、Sidebar、focus、fold、Jump List位置      | 内容正本ではない     |
| 一時state      | IME composition、検索query、Visual selection、picker          | 永続化しない         |

## 2. IDとschema

永続entityのIDにはlowercase UUIDv7を使う。loadとmutationの両方で形式と一意性を検証する。

| 対象                     | 現行schema |
| ------------------------ | ---------- |
| WorkspaceMetadataDoc     | 3          |
| NoteDoc                  | 3          |
| SQLite database          | 5          |
| Workspace search index   | 9          |
| 内部Clipboard            | 7          |
| Application Window state | 9          |
| data area                | 1          |

schemaの未知の新versionは、意味を推測して開かず明示的に拒否する。既知の旧versionは定義済みmigrationだけを
通して変換する。migration前のNote snapshot/update logはbackup tableへ保持する。

## 3. WorkspaceMetadataDoc

WorkspaceMetadataDocはNote metadataとMain Namespaceの配置を分離して保持するYjs文書である。

```text
WorkspaceMetadataDoc
├── workspace_id
├── schema_version = 3
├── notes[note_id]
│   ├── title_cache
│   ├── created_at / updated_at
│   ├── deleted_at? / trash_operation_id?
│   └── system_role?
└── main_namespace
    ├── namespace_id
    └── entries[entry_id]
        ├── parent_entry_id?
        ├── position
        ├── target? = { kind: "note", id: NoteId }
        ├── name?  # targetなしのグループのみ
        ├── created_at / updated_at
        └── deleted_at? / trash_operation_id?
```

不変条件は次のとおりである。

1. live Entryは親を高々1つ持ち、top-levelでは`parent_entry_id`がnullである。
2. live Entryの親は同じNamespaceのlive Entryである。Note付きEntryもグループも子を持てる。
3. self-parent、循環、orphan、deleted parentとlive childの組み合わせを拒否する。
4. virtual rootを永続化しない。
5. live Noteを参照するlive Entryはちょうど1つである。Entry IDをNote IDと兼用しない。
6. Note付きEntryの名前はRoot Section titleから導出する。`title_cache`は第二の正本ではない。
7. グループだけがEntryに`name`を持つ。空グループからNoteを暗黙作成しない。
8. 配置、兄弟順、祖先pathの変更だけではNoteの`updated_at`を変更しない。
9. Namespaceの深さへSectionのH6制限を流用しない。循環と走査量は検証する。

### 3.1 sibling順序

`position`は同じ親を持つEntryのsibling集合内だけで比較する。jitter付きFractional Indexingを使用し、
同じindexが衝突した場合はEntry IDのbytewise順を第2 sort keyにして順序を決定する。
挿入余地がなくなった場合は衝突した局所範囲だけを再採番し、通常操作ごとにWorkspace全体を並べ直さない。

## 4. NoteDocとSection

1 Noteにつき1 NoteDocを持つ。NoteDocは再帰的なSection treeである。

NoteDocの`schema_version`は5。ListItemは非空の`Block+`を持ち、先頭をParagraphに限定しない。
v5でDetails / DetailsSummary / DetailsBodyを追加する。
v3/v4からはmetadataだけを更新し、本文、Block/Section/BodyChunk ID、Yjs内の本文要素を作り直さない。
v2からは既存のBodyChunk化も行う。移行updateを永続化し、旧履歴の読み取りを維持する。
v5非対応の旧アプリでの再編集は非対応とし、未知schemaを拒否して暗黙の内容欠落を防ぐ。
WorkspaceMetadataDocのschemaは3のままである。

```text
NoteDoc
└── Root Section
    ├── Header
    ├── Body
    │   └── BodyChunk*
    │       └── Block*
    └── Children
        └── Section*
```

- Root Section IDはNote IDと同一である。
- Root HeaderのtextがNote titleの正本である。
- Root以外のSectionは独立したUUIDv7を持つ。
- RootをH1/深さ0とし、最大H6/深さ5とする。超過を平坦化・分割せず、操作全体を拒否する。
- SectionはHeader、直接Body、子Sectionを持つ。
- Sectionを移動、yank、put、昇格、降格するときは、そのsubtreeの構造と表示順を保つ。
- 同一Note内の構造copyでは貼り付け側にfresh IDを割り当て、既存entityと衝突させない。

最終的なSection treeにあるすべてのIDがvalidかつ一意で、Root IDがNote IDと一致することをload時に検証する。
Yjs履歴のreplay中に内部要素とIDの対応が変わること自体はidentity変更と判定しない。最終IDが欠損している場合だけ、
過去に同じ要素で観測され、他の最終Sectionが使用していないvalid IDが一意に決まるときに限り修復する。

## 5. BodyChunk

BodyChunkは大きなNoteDocの本文を分割して扱う物理格納・Editor mount単位であり、
Vimの論理行、Clipboard、検索、Markdown、Section snapshotからは透過である。

- 分割目安は256 blockまたはUTF-8換算128 KiBである。
- 強制上限は512 blockまたは256 KiBである。
- TableやCode Blockなどのatomic blockは途中分割せず、単独blockがbyte上限を超えることを許す。
- Editorはselectionを含むchunk、隣接chunk、viewport付近を合わせて最大6 chunk相当だけ編集可能DOMとしてmountする。
- その他のchunkは同じProseMirror documentから導出した静的表示にする。
- keyboard motionが到達する前に対象chunkを編集可能状態へ戻す。
- Vim motion、operator、IME、Undoはchunk境界を透過する。
- offscreenへのmouse dragによる連続選択は保証しない。

旧NoteDocはWorkspace全体のnative移行前検査を通し、既存block順とIDを保ってBodyChunkへ包む。

## 6. block identity

永続blockはstableなlowercase UUIDv7を持つ。構造を維持する移動や型変換では、論理的に同じblockのIDを維持する。
copy、外部paste、新規作成ではfresh IDを使う。

Table、Code Block、Image、Attachment、Horizontal Rule、Internal Linkなどは、それぞれの操作境界でatomicに扱う。
Internal Linkは表示textではなくtarget IDを保持し、表示名はtarget titleから導出する。

## 7. Yjs、transaction、revision

TipTapの編集状態はYjs bindingを通してNoteDocへ反映する。UIが同じ変更を独自に再適用してはならない。
IME composition中のDOM mutationもYjs/ProseMirrorの単一経路で確定する。

永続変更はCore transactionで処理する。

1. 呼出時のexpected revisionとcurrent revisionを比較する。
2. command input、ID、tree不変条件を検証する。
3. Yjs updateまたはmetadata変更を確定する。
4. snapshot/update logとrevisionをSQLiteへ保存する。
5. FTS、title cacheへ確定revisionを通知し、内容変更の`content_epoch`で次のbackup対象を判定する。
6. UIへ新しいstateまたはtyped errorを返す。

revision conflictでは古いintentを自動上書きせず、最新stateに対して再解決できる操作だけを再試行する。

## 8. snapshot、update log、Undo

確定したYjs updateはappend-only logとして保存し、snapshotと組み合わせて再起動時に復元する。
一定条件でcompactionし、同じcurrent stateを新しいbaselineへまとめる。compaction中も確定済みupdateを失わず、
失敗時は古いsnapshot/logから復元できる。

Undo/Redo historyは実行中sessionのEditor stateに属し、アプリ再起動後には引き継がない。
永続的な過去状態はResticの世代として保存し、履歴previewまたは読み出しCLIで参照する。

同じNoteDocを複数Windowで開いた場合、本文とrevisionは共有する。caret、mode、selection、Focused Section、
fold、scroll、Jump ListはWindowごとに分離する。

## 9. Tree projectionと検索projection

Tree表示はWorkspaceMetadataDocから次の順で導出する。

1. deleted Entryを除く。
2. parent-child adjacencyを構築する。
3. 各siblingを`position`、Entry IDの順にsortする。
4. 展開状態を適用してdepth-firstに平坦化する。
5. viewport付近だけを表示する。

FTS indexは再構築可能なSQLite派生dataである。Note本文indexへ祖先pathを複製せず、
結果表示時にWorkspace metadataから現在のpathを解決する。親変更や祖先renameだけでは
子孫本文を再indexしない。

## 10. local UI state

Application Window、TabPage、split tree、Window、Buffer参照、Sidebar、focus ownerは端末固有の
Application Window stateとして保存する。NoteDocやWorkspaceMetadataDocには保存しない。
Treeの選択/foldはEntry ID、BufferとJump Listの参照はNote/Section IDを使う。
split ratio、左右Sidebarの幅、Tab内のprevious Window IDもこのlocal stateに属する。
previous Window IDは旧保存dataでは省略可能であり、未設定なら直前Windowへの移動はno-opとする。
Windowを閉じる際は残ったTabから無効なprevious参照を除く。

Section foldとFocused SectionもWindow-localである。同じNoteを別Windowで開いても表示範囲は独立する。
Visual selection、IME composition、検索query、Command-line入力、picker選択は一時stateであり、
通常は再起動後へ持ち越さない。

## 11. Trash

Treeの削除は永続消去ではなくmetadata上のTrash移動である。

- 選択Entryの削除は、その時点でliveな子孫Entryとtarget Noteを同じ`trash_operation_id`で原子的にTrashへ移す。
- Noteを持たないグループだけのsubtreeも検索・復元できる。
- 以前の別操作ですでにTrashへ移された子孫を、後から親を削除したoperationへ取り込まない。
- 同じoperationで削除したsubtreeは`r`でまとめて復元する。
- 復元に必要な親が別operationのTrash内にある場合は、祖先を先に復元するまで拒否する。
- 削除Noteを表示していたWindowは利用可能な既存BufferまたはEmpty Bufferへ移る。
- live Noteが残らなくても代替Noteを暗黙作成しない。
- 永続削除は実装しない。

Trash操作はWorkspace transactionであり、Editor本文のUndo/Redoや`.` repeatには含めない。
