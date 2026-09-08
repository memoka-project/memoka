# 外部エージェント向けCLI編集

[仕様書へ戻る](../specification.md)

## 1. 公開範囲

`memoka-cli`は現在のWorkspaceの既存Noteを、Section/Block IDで限定して編集する。
GUI ownerがあれば同一ユーザーのowner IPCへ接続し、なければWorkspace leaseを取得してnative処理だけで実行する。
CLIのためにNode、DOM、GTK、WebKit、非表示Editorを起動しない。ownerへの接続失敗を別writerへの切替理由にしない。

対応操作は本文の局所置換、直接BodyへのMarkdown追記・挿入、既存タスクの完了状態設定である。
Note/Sectionの新規作成、削除、rename、移動、見出し編集、全体置換、複数Noteのtransaction、
添付取り込み、アプリ設定変更、過去世代・Trash・管理Helpの編集には対応しない。diffは確認用出力であり入力形式ではない。

## 2. 編集用の読み出し

```text
memoka-cli read --id ID --for-edit --format json [--workspace DIR] [--limit N] [--cursor CURSOR]
```

通常の`read`は従来どおりである。`--for-edit`はcurrent専用で、`--generation`と`--include-trash`を拒否する。
Note ID指定は同じIDのRoot Sectionを意味する。

応答は`schema_version: 1`、`representation: "edit_view"`、`source: "current"`、`workspace_id`、
`note_id`、`section_id`、Note全体の`revision`、`scope: "body"`を持つ。
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
`edit-schema`はRust DTOから生成したJSON Schema、command形式、上限を返す。

共通fieldは`schema_version: 1`、`workspace_id`、`note_id`、`expected_revision`、`request_id`、`edits`である。
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

Note単位の`expected_revision`を保存直前に再検証する。別Sectionの変更も競合とし、自動rebase/forceは行わない。
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
`changes`はSection IDと`unified_diff`。diffが上限を超えれば明示的に省略し、文書の保存可否とは分離する。

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

## 6. 共通スキルと参照資料

配布用の共通スキルは[`skills/memoka`](../../skills/memoka/SKILL.md)に置く。
手順・安全境界はSKILL.md、CLI引数とJSON Schemaは生成したreferencesへ分ける。
`corepack pnpm agent:reference`でCLI定義から再生成し、`agent:reference:check`で差分を検出する。
インストール操作は利用者が外部skillsツールで行い、Memoka内の管理画面・独自installerは提供しない。
