# 外部エージェント向けCLI編集

[仕様書へ戻る](../specification.md)

## 1. 公開範囲

`memoka-cli`は現在のWorkspaceの既存NoteをSection/Block IDで限定して編集し、Noteの作成・改名とNamespace上の配置変更を行う。
GUI ownerがあれば同一ユーザーのowner IPCへ接続し、なければWorkspace leaseを取得してnative処理だけで実行する。
CLIのためにNode、DOM、GTK、WebKit、非表示Editorを起動しない。ownerへの接続失敗を別writerへの切替理由にしない。

本文編集は局所置換、直接BodyへのMarkdown追記・挿入、既存タスクの完了状態設定である。
`note-edit`でNoteの作成・Root titleの改名、Note/group entryの移動・並び替えにも対応する。
`section-edit`は同じNote内のSection作成・改名・subtree移動・削除と、既存本文のSection化を扱う。
Note削除、Note間Section移動、group作成・改名、全体置換、複数既存Noteのtransaction、
添付取り込み、過去世代・Trash・管理Helpの編集には対応しない。diffは確認用出力であり入力形式ではない。
アプリ外観と日本語分割の設定は、Workspaceとは独立した`config get/set/schema`で扱う。

## 2. 編集用の読み出し

```text
memoka-cli read --id ID --for-edit --format json [--workspace DIR] [--limit N] [--cursor CURSOR]
```

通常の`read`は従来どおりである。`--for-edit`はcurrent専用で、`--generation`と`--include-trash`を拒否する。
Note ID指定は同じIDのRoot Sectionを意味する。

応答は`schema_version: 1`、`representation: "edit_view"`、`source: "current"`、`workspace_id`、
`note_id`、`section_id`、Note全体の`revision`、`scope: "body"`を持つ。
構造編集の文脈として`title`、`parent_section_id`（Rootはnull）、`depth`（Rootは0）も返す。
`blocks`は対象Sectionの直接Bodyを表示順に平坦化した一覧である。ListItemや引用等の内側も含めるが、
子Sectionの本文は含めず、`children`に直接の子のIDとtitleを返す。BodyChunkは隠す。

各blockは次の情報を持つ。

| field                         | 意味                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `block_id` / `kind`           | stable IDとblock種別                                     |
| `parent_block_id`             | 入れ子blockの親。直接Bodyのtop-levelはnull               |
| `insert_anchor`               | `insert_markdown`のanchorにできるか                      |
| `editable_segments: [{text}]` | 完全一致置換に使うliteral text                           |
| `markdown`                    | 確認用Markdown。編集対象の文字列をこの表現から推測しない |
| `read_only_reason`            | text編集非対応の場合の理由                               |
| `checked`                     | ListItemの状態。nullは通常項目、booleanはタスク          |

編集可能なsegmentはParagraphの連続した同一mark属性のtextである。List、引用、Alert、Details本文の
Paragraphも含む。同じmarkが続くXML text要素は連結するが、mark変更、Hard Break、atomic inlineは境界にする。
Table配下、Code/Source、Details Summary、見出し、内部リンクの表示名は置換対象にしない。
Unicode正規化、大文字小文字変換、空白の圧縮、Markdown記号への変換は行わない。

`limit`は1〜1000件、既定100件。`next_cursor`はWorkspace/Note/Section/revisionに束縛する。
revisionや対象が変われば`CURSOR_STALE`で再読取を要求する。
1 blockの応答は256 KiB、1 pageは概ね1 MiB、全応答は2 MiBを上限にする。
大きすぎるblockは`omitted: true`、`read_only_reason: "BLOCK_TOO_LARGE"`、空segment、null Markdownを返し、
一部のtextだけを編集可能として見せない。入れ子の子blockはそれぞれの上限で判定する。

## 3. 編集リクエスト

```text
memoka-cli edit --input FILE|- --format json [--workspace DIR] [--dry-run]
memoka-cli edit-schema --format json
```

`FILE`はUTF-8 JSON、`-`は標準入力である。shellで本文を解釈・実行せず、外部URLをfetchしない。
`edit-schema`はRust DTOから生成したJSON Schema（本文用`request`、Note操作用`note_request`、Section操作用`section_request`）、command形式、上限を返す。

本文編集のfieldは`schema_version: 1`、`workspace_id`、`note_id`、`expected_revision`、`request_id`、`edits`である。
entity IDはlowercase UUIDv7。request IDはcanonical lowercase UUIDv4/v7。revisionは正のJavaScript safe integerとする。
不明field、重複JSON key、不正ID、深すぎるJSONを拒否する。

| op                 | 必須fieldと動作                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `replace_text`     | `section_id`, `scope: "body"`, `old_text`, `new_text`。`block_id`は任意。1 segment内で重なり合う一致も数え、ちょうど1件だけを置換する |
| `append_markdown`  | `section_id`, `markdown`。直接Bodyの論理末尾、子Section群より前へblockを追加する                                                      |
| `insert_markdown`  | `section_id`, `anchor_block_id`, `position: "before" / "after"`, `markdown`。直接Bodyのtop-level anchorの前後へ追加する               |
| `set_task_checked` | `section_id`, `block_id`, `checked: boolean`。既存タスクListItemの状態だけを設定する                                                  |

`old_text`は空にできず、置換の両文字列にCR/LFを許さない。`new_text: ""`でもParagraph自体は残す。
`old_text === new_text`も一致件数・対象を検証し、成功時はno-opとする。既存mark、Block IDを保ち、
`**`や`[ ]`等の`new_text`をMarkdownとして解釈しない。

Markdown挿入はParagraph、Bullet/Numbered/Task List、通常のBlockquote、および太字・斜体・打ち消し・
inline code・highlight・安全な外部link・同一WorkspaceのInternal Section Linkに対応する。
内部リンクは`memoka://workspace/<Workspace ID>/section/<Section ID>`で指定し、live targetを検証する。
Heading、Table、Code/Source、Details、Alert、raw HTML、画像・添付などの未対応構造を含む場合は全体を拒否する。
空白だけのMarkdownも拒否する。未対応構造を平坦化したりSource Blockに逃がしたりしない。

すべてのopは同じbase snapshotに対して解決する。先行opの生成text/IDを後続opから参照しない。
置換範囲の重複、同一タスクへの重複代入を拒否する。同じタスクのtext編集と状態設定は併用できる。
同じgapへの挿入はrequest順とし、before/after/appendが同じgapを指す場合も同様である。
既存Paragraphとは自動結合しない。新規blockだけにfresh IDを割り当て、必要なBodyChunk分割でも論理IDと順序を保つ。

1 requestは1 MiB、1〜100 op、新規block最大10,000件、確認diff最大64 KiB、応答最大2 MiBとする。
巨大blockや大量のSectionを無制限にまとめるAPIにはしない。

## 4. 永続化・GUIとの整合

本文編集・Note rename・Section操作ではNote単位の`expected_revision`を保存直前に再検証する。別Sectionの変更も競合とし、自動rebase/forceは行わない。
Workspace metadataが準備中に変わった場合も再読取を要求する。

GUIではまず確定編集の保存barrierと既存Note queueを通す。解析・対象解決・diff・staging更新はnative workerで行い、
live Yjsを準備用に変更しない。準備中にユーザーが対象Noteを編集した場合、適用前に無変更で拒否する。
IME変換中は強制確定・focus移動をせず`IME_ACTIVE`で拒否する。短いcommit境界の後にcompositionが始まった場合も、
その終了を待って公開する。非表示Noteの編集にEditor mountやTab切替を要求しない。

文書update、Note/Workspace revision、Noteの`updated_at`、FTS invalidation、`content_epoch`、receiptを
同じSQLite transactionで確定する。どれかが失敗すれば、このrequestの変更は一切残さない。
先行するユーザー編集の通常保存まで巻き戻す意味ではない。全opがno-opならreceiptだけを記録し、内容のrevisionとepochを進めない。

DB確定後だけ、識別可能な外部編集originでGUI文書へ同じupdateを公開する。複数Windowの内容は同期するが、
focus、caret、scroll、foldを初期化しない。外部originを再度autosaveしたり、ユーザーUndoへ混入させたりしない。
既存ユーザーUndoは外部変更をまとめて巻き戻さない。外部編集専用Undoは提供せず、履歴captureは通常の周期である。

## 5. 応答と再送

成功応答は`schema_version: 1`、`ok: true`、`request_id`、`status`、`revision_before/after`、
`applied_edits`、`validated_edits`、`changed_block_ids`、`created_block_ids`、`changes`、`diff_truncated`、`replayed`を持つ。
本文編集の`changes`はSection IDと`unified_diff`。diffが上限を超えれば明示的に省略し、文書の保存可否とは分離する。

`status`は`applied`、`no_change`、`preview`。dry-runは文書・receipt・Undo・revision・epochを変更せず、
適用数は0とする。新規IDは予約せず、本適用時に変わり得る。dry-runはロックや承認tokenではない。

照合keyは`(workspace_id, request_id)`。検証済みDTOのcanonical hashを用い、object key順やJSON整形は無視するが、
文字列の空白・Unicode・配列順・revisionはそのまま照合する。確定済みreceiptはrevision、対象の生存、IME/busy判定より先に確認する。
同じrequestなら元の結果へ`replayed: true`を付けて返す。内容が違えば`REQUEST_ID_REUSED`とする。
receiptは自動期限切れにせず、DBとともに履歴・バックアップへ含める。ただし過去への復元やWorkspace分岐をまたぐ無期限の再送保証ではない。

失敗はstdoutのJSONで`ok: false`、`error: {code, message, details}`、`commit_state`を返し、非zero exitとする。
曖昧一致は最大5件の候補と全件数、省略有無を返す。op失敗には`operation_index`とSection IDを付ける。

| エラー例                                                    | 呼出側の対応                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `REVISION_CONFLICT`, `WORKSPACE_CHANGED`, `CURSOR_STALE`    | 新しい状態を読み、変更内容を判断し直す                      |
| `MATCH_NOT_FOUND`, `AMBIGUOUS_MATCH`, `OVERLAPPING_EDITS`   | 対象と操作を見直す。曖昧なまま適用しない                    |
| `INVALID_TARGET`, `READ_ONLY_TARGET`, `UNSUPPORTED_CONTENT` | 対応範囲を確認する。別経路で強制変更しない                  |
| `IME_ACTIVE`, `EDIT_BUSY`                                   | ユーザー入力が落ち着くまで待つ                              |
| `MIGRATION_REQUIRED`                                        | 更新したGUIでWorkspaceを先に開く。standaloneで移行しない    |
| `commit_state: "unknown"`                                   | 同じID・内容で再送しreceiptを照合する。新規IDで再実行しない |

保存済みでTauri応答だけが失われた場合は、同じnative ticketの保持済みdeliveryを再取得してから保存queueを解放する。
process再起動後はDBとreceiptから回復する。再送の`revision_after`は現在revisionではなく、そのrequestを最初に確定したrevisionである。

## 6. 既知のWorkspace一覧

```text
memoka-cli workspaces --format json
```

GUIで明示的に開いたWorkspaceのpathを最近利用した順に最大100件記憶する。
`selected-workspace.json`のschema 1を保ち、現在の`path`と`recentPaths`をatomicに保存する。
旧形式の選択fileからは現在pathのみを引き継ぐ。過去に開いた全Workspaceを遡って発見する機能ではない。

応答は`schema_version: 1`、`source: "known_workspaces"`、`items`、`total`。
各itemは`path`、`selected`、`available`を持つ。`available`はdirectoryとdata-area markerの存在の目安であり、
DBの健全性や権限を保証しない。未mount/削除されたpathも`available: false`で残す。
一覧取得はfilesystem探索・Workspace選択・初期化・移行・DB open・sidecar起動をしない。
設定がなければ空一覧を返し、設定directoryも作らない。IDは対象を明示した`tree`等で解決する。

## 7. Noteの作成・改名・配置

```text
memoka-cli note-edit --input FILE|- --format json [--workspace DIR] [--dry-run]
```

本文編集と同じowner IPC・native準備・保存barrier・SQLite transaction・receipt・GUI公開経路を使う。
1 requestは1 action、上限1 MiBとする。共通fieldは次のとおり。

```json
{
  "schema_version": 1,
  "workspace_id": "<Workspace UUIDv7>",
  "expected_workspace_revision": 42,
  "request_id": "<fresh UUIDv4/v7>",
  "action": {
    "op": "create",
    "title": "新しい記事",
    "parent_entry_id": null,
    "placement": { "kind": "last" },
    "markdown": "**概要**\n\n- [ ] 確認する"
  }
}
```

`expected_workspace_revision`は最新の`tree`の`source.workspace_metadata_revision`を指定し、準備時と保存直前に照合する。
本文編集のNote revisionとは区別する。renameのみNoteの`expected_revision`も必要とする。
titleは改行・NULを含まない最大4096 UTF-8 bytesのliteral text。空文字は許可し、GUIは「新しいノート」をplaceholder表示する。

| action   | fieldと動作                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------ |
| `create` | `title`, `parent_entry_id`, `placement`, 任意`markdown`。新しいNoteとその唯一のentryを同時に作る |
| `rename` | `note_id`, `expected_revision`, `title`。Root titleとWorkspaceのtitle cacheだけを変更する        |
| `move`   | `entry_id`, `parent_entry_id`, `placement`。Noteまたはgroupのentryを子孫ごと移動・並び替える     |

parent/anchorにはNote IDではなくNamespaceのentry IDを指定する。親はlive Note/group entry、`null`（省略時も同じ）はNamespace直下。
`placement`は`{"kind":"first"}`、`{"kind":"last"}`、または`{"kind":"before"|"after","entry_id":"<anchor>"}`。
before/afterのanchorは指定した親の下にある別のlive siblingでなければ拒否する。
自己・子孫への移動は拒否し、既に要求した親・表示順にあればno-opとする。Trashや管理Help自体へのrename/moveは拒否する。

作成時のNote/entry IDはCoreが新規生成し、Root Section IDはNote IDとする。初期本文を省略すると空Paragraphを1つ持つ。
Markdownは本文編集と同じ限定subsetで、空白だけの場合や見出し等の未対応構造はrequest全体を拒否する。
本文・子Section全体を書き戻すAPIではない。renameでも本文、Section/Block ID、entry配置は維持する。

配置にはfrontendと同じbase62 fractional indexと64-bit jitterを使う。
同値positionはentry IDでtie-breakし、挿入gapが同値の中にある場合だけ当該bucketを表示順のまま再採番する。
一度の局所再採番は1000 entryまで、positionは1024文字までとし、上限超過は無変更で拒否する。
移動ではNoteDoc・Note revision・Noteの`updated_at`を変更しない。祖先pathの変更で子孫本文のFTS再索引を行わず、Namespace hierarchyだけ更新する。
新規・改名では当該Noteだけを索引更新し、非表示NoteのためにEditorをmountしない。

応答には`note_id`（group移動はnull）、操作によって`entry_id`、`workspace_revision_before/after`、`revision_scope`を追加する。
create/moveの`revision_before/after`はWorkspace、renameはNoteのrevisionを示す。
`changes`はcreateのtitle/親/配置/初期Markdown、renameのtitle前後、moveの親・position前後の意味的な差分を返す。
本文のunified diffとは異なる。64 KiBを超えれば`changes: []`と`diff_truncated: true`で省略する。
局所再採番したentry IDは`reindexed_entry_ids`に含める。

作成のdry-runで返す新規IDは予約ではなく、本適用時に変わり得る。作成結果が不明なら必ず同じrequestを再送する。
保存済みrequestの再送は同じ生成IDと元の結果を返し、二重作成しない。
新規作成・移動を含め、GUIの現在Note・Window focus・caret・scroll・foldを変更せず、ユーザーUndoへ混入させない。
Namespace操作のうち対象Noteが固定されない作成・移動は、いずれかのEditorでIME変換中なら拒否する。

## 8. 共通スキルと参照資料

配布用の共通スキルは[`skills/memoka`](../../skills/memoka/SKILL.md)に置く。
手順・安全境界はSKILL.md、CLI引数とJSON Schemaは生成したreferencesへ分ける。
`corepack pnpm agent:reference`でCLI定義から再生成し、`agent:reference:check`で差分を検出する。
インストール操作は利用者が外部skillsツールで行い、Memoka内の管理画面・独自installerは提供しない。

## 9. アプリ設定の読み書き

`config get --format json`はOSユーザーの`config.toml`のpath、有効値、正確なfile bytesのSHA-256 `revision`を返す。
Workspace指定・選択・DB open・owner IPC・sidecar・ネットワークは使わない。file不在は既定値を返し、作成しない。
`config schema --format json`はRust DTOから生成したrequest schema、変更可能なkey、値の制約、テーマ定義を返す。

`config set --input FILE|- --format json [--dry-run]`はUTF-8 JSONを受け付ける。
必須fieldは`schema_version: 1`と`expected_revision`。`set`は設定keyから値へのmap、`unset`は既定へ戻すkeyまたは削除するテーマ定義のkeyの配列。
両者合わせて1〜128件。入出力設定・requestは256 KiB以下。不明field・重複JSON key・set/unset重複・不正な値を拒否する。
変更可能なkeyは[設定仕様](configuration-and-commands.md#12-cliからの設定変更)のallowlistに限り、任意Ex commandの実行は提供しない。

GUIとCLIは同じ検証・排他lock・atomic file置換を使用する。コメントと無関係な設定を保持し、Windowsでも旧fileを先に削除しない。
symlink/reparse point経由の設定書換えを拒否する。CLIはlock取得後にrevisionを確認し、異なれば`CONFIG_CONFLICT`（exit 10）で無変更とする。
競合を自動rebaseしない。排他中は`CONFIG_BUSY`。外部テキストエディタ等、Memokaのlockに従わないwriterとの同時保存までは保証しない。

dry-runはfile・directory・lockを作成せず、`status: "preview"`、適用予定の`revision_after`、有効値の`changes`を返す。
適用結果は`applied`または`no_change`、前後revision、`changes`、削除した明示設定の`unset_keys`を返す。
明示設定の削除は有効値が同じでも保存する。既に有効な値の再代入だけならfileを書き換えない。
Note用のreceipt/request IDは持たない。応答が不明な場合は`config get`で確認し、古いrevisionを最新値へ機械的に差し替えて再送しない。
設定はNoteのUndo・履歴・バックアップとは独立する。キー設定・資格情報・バックアップ設定はこのAPIの対象外。

## 10. 同じNote内のSection構造編集

```text
memoka-cli section-edit --input FILE|- --format json [--workspace DIR] [--dry-run]
```

本文編集と同じNote revision・owner IPC・保存barrier・native準備・atomic保存・receiptを使う。
1 requestは1 action。共通fieldは`schema_version: 1`、`workspace_id`、`note_id`、
`expected_revision`、`request_id`、`action`である。`expected_revision`は最新の`read --for-edit`で得た**Note全体**のrevisionで、Workspace revisionではない。

```json
{
  "schema_version": 1,
  "workspace_id": "<Workspace UUIDv7>",
  "note_id": "<Note UUIDv7>",
  "expected_revision": 42,
  "request_id": "<fresh UUIDv4/v7>",
  "action": {
    "op": "create",
    "parent_section_id": "<Note UUIDv7>",
    "placement": { "kind": "last" },
    "title": "新しいセクション",
    "markdown": "本文と**強調**\n\n- [ ] 次にすること"
  }
}
```

| op           | fieldと動作                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | `parent_section_id`, `placement`, `title`, 任意の`markdown`。直接の子を1つ作る。初期本文は本文挿入と同じMarkdown subset。省略時は空Paragraph |
| `rename`     | `section_id`, `title`。non-root Sectionのタイトルだけをliteral textとして変更                                                                |
| `sectionize` | `section_id`, `heading_block_id`。直接BodyのParagraphをタイトルへ変換し、後続Body全体を先頭の子Sectionへ移す                                 |
| `move`       | `section_id`, `parent_section_id`, `placement`。本文・子孫を含むsubtreeを再配置。親変更と兄弟間の並び替え                                    |
| `delete`     | `section_id`, `mode: "empty" / "subtree"`。削除範囲を明示。`mode`省略は拒否                                                                  |

タイトルは空も可、最大4096 UTF-8 bytes、CR/LF/NUL不可である。
RootはNote IDと同一である。Rootの改名は`note-edit`のみ。Root移動・削除とNote間移動は非対応。
作成・移動とも親は明示したSection ID（Rootの場合もnullではない）とし、既存の親本文を新しい子へ移さない。
本文を分割しない`create`/`move`と、本文を分割する`sectionize`を区別する。

### 10.1 既存本文のSection化

`sectionize`の対象は、指定したSectionの直接BodyにあるParagraphのみ。RootのBodyにも使える。
対象Paragraphのtextを単一行タイトルとする新しいSectionを**先頭の子**に作り、対象より後ろの直接Bodyをすべて移す。
対象より前のBodyと既存の子Section（その子孫を含む）はそのまま残す。表示順を変える任意の中間範囲・配置指定は設けない。
兄弟にしたい見出しが複数ある場合、末尾から先頭へ順に実行する。毎回最新revisionを読み直す。

```json
{
  "op": "sectionize",
  "section_id": "<元のSection UUIDv7>",
  "heading_block_id": "<直接BodyのParagraph UUIDv7>"
}
```

タイトル化するParagraphは消費され、新しいSection IDへ対応付く。空タイトル・空の後続Bodyも可で、空Paragraphを残したり補ったりしない。
見出しのbold/italic/strike/code/highlightはSectionのタイトル表示へ置き換わる。リンクなどそれ以外のmark、inline atom、
Hard Breakは`UNSUPPORTED_CONTENT`で拒否し、不可視情報を黙って捨てない。タイトル長・禁止文字は通常のタイトルと同じ。
新規Sectionのtagsは空、emojiはなし。既存本文のBlock ID、typed属性、rich text、添付参照はそのまま保ち、Markdown再解釈しない。
prefixの共有typeを保持し、移動するsuffixだけをcloneして同一transactionで元を削除する。
丸ごと移るBodyChunkはIDを保持し、境界で分割した新しいChunkだけ新IDとする。空Chunkは残さない。
移動対象全体（消費する見出しを含む）に10,000 nodes / 8 MiBの制限を適用し、新Sectionも深さ制限に従う。

結果の`section_id`は新Section ID。`deleted_block_ids`に消費した見出し、`moved_block_ids`に本文のID、
`sectionized_heading: {block_id, section_id}`に変換元・先を返す。GUIはこの対応で見出し上の選択位置を新タイトルに復元し、
後続本文は従来通りBlock IDとoffsetで復元する。WindowのFocused Sectionは切り替えない。
`changes`には元Paragraphの`heading_before`、`title`、親ID、index 0、移動ID、直接本文数とSection Markdownを返す。

### 10.2 共通の配置・保存・結果

placementは`{"kind":"first"}`、`{"kind":"last"}`、
`{"kind":"before","section_id":"兄弟ID"}`、`{"kind":"after","section_id":"兄弟ID"}`。
anchorは移動先親の別の直接の子でなければならない。移動元を除いた兄弟列で挿入位置を決める。
別NoteのID、自身/子孫への移動、移動元自身をanchorにする指定を拒否する。既に同じ位置や同じタイトルならno-op。
最大深さはNote Rootを0として5。作成先と移動後の子孫すべてに適用し、超過時は`SECTION_DEPTH_LIMIT`。

`empty`削除は子Sectionがなく、Bodyが空または空Paragraphのみの場合に限定する。
内容のあるParagraph、空でもCode/Table/画像等の構造を持つBody、子Sectionの存在は`SECTION_NOT_EMPTY`で拒否する。
`subtree`はそのSection・本文・全子孫を削除する明示指定であり、拒否後に自動でこのmodeへ切り替えない。
削除によって既存の内部リンクは未解決になり得る。リンク元を書き換えたり別のSectionへ付け替えたりしない。

移動は既存Section/Block/BodyChunk ID、タグ・emoji、typed属性、rich text、添付参照を保持する。
Yjsの共有type自体は再parentできないため、native側で**対象subtreeだけ**を型付きで複製し、同じtransaction内で元を削除する。
無関係なSection、本文、Rootは作り直さない。内部リンクの参照IDを保ち、移動先の深さ色・Outlineを更新する。
GUIの各Windowの選択はBlock/Section IDとoffsetで退避・復元し、移動したSectionにフォーカス中なら新しい共有typeへ再bindする。
削除されたSectionにフォーカス中のWindowは削除元の親（RootならNote全体）へ戻し、失われた選択も親titleへ戻す。
削除したIDはWindow-local foldとOutline選択から整理する。無関係なWindowやactive Tabは切り替えない。
非表示NoteのSection候補も再読込し、検索・リンク表示のためだけにBuffer/Editorを作らない。

requestは1 MiB。作成・移動・削除・Section化の対象は10,000 nodes（SectionとBody内のtextを含むJSON nodes）、
serialized Section modelで8 MiBまで。既存Note全体を無制限に複製するAPIではない。
moveはBody編集のMarkdown subset外のブロックも保持するが、新規Markdown取り込みの対応範囲は広げない。

結果は`revision_scope: "note"`、対象`section_id`、`affected_section_ids`、`created_section_ids`、
`deleted_section_ids`、`created_block_ids`、`deleted_block_ids`を返す。削除は`fallback_section_id`も返す。
`changes`はcreateの親・index・title・Markdown、renameのbefore/after、moveの前後parent/indexとsubtree ID、
deleteの対象ID・削除Markdownを持つ意味的差分。indexは0始まり。64 KiB超過時は`changes`を省略し`diff_truncated: true`を返す。
全応答は2 MiB以内。previewのIDは予約しない。receiptの再送は生成IDを含む確定済み結果を返す。
次の操作は適用後に読み直してから作り、過去のrevisionの連番を推測しない。GUI Undoへは追加しない。
