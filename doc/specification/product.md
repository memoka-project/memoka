# プロダクト

[仕様書へ戻る](../specification.md)

## 1. コンセプト

Memokaは、Vimの操作感でMarkdownを意識せずサクサク書ける、keyboard-firstのローカルメモ帳である。
WYSIWYGな構造化Editorを使いながら、移動、選択、編集、Window操作をVimに近い一貫したkeyで行う。

主要な価値は次のとおりである。

- Markdown記号の手編集を必須にせず、Section、List、Table、Code、Link、Attachmentを直接編集できる。
- Note Treeでノートを大まかに整理し、Note内は再帰的なSectionで構造化できる。
- 通常の編集をローカルで完結させ、network障害や外部serviceに依存しない。
- 内部正本とは別に、人が読めて外部toolで世代管理できるMarkdown mirrorを自動生成する。
- 同一Noteを複数Windowで開いても、CRDTを介して内容を即時に共有する。

## 2. 採用構成

- Desktop shellはTauri 2を使用する。
- EditorはTipTap / ProseMirrorを使用する。
- NoteDocとWorkspace metadataの共同編集表現にはYjsを使用する。
- 永続metadata、snapshot、update log、検索indexはSQLiteへ保存する。
- 添付bytesはSHA-256 content-addressed storageへ保存する。
- Markdownはimport、Clipboard交換、portable mirrorに使用し、通常編集の正本にはしない。

UI、Core、永続化の責務を分離する。UIは入力意図をtyped commandとしてCoreへ渡し、Coreがvalidationと
transactionを行う。検索index、mirror、title cacheなどの派生物は、Coreで確定したrevisionを基準に更新する。

## 3. Note TreeとSection tree

Note TreeとSection treeは異なる目的を持つ。

- Note TreeはNoteの発見、作成、順序変更、親変更、Trashを行うWorkspace projectionである。
- Section treeは1 NoteDoc内の本文構造であり、Editor、Outline、Focused Section、構造Clipboardの対象になる。
- 子Noteは親Noteを高々1つ持つ。
- 親Noteを開いても子NoteDocを同じEditorへ連結しない。
- 1 Windowの編集対象は常に1 NoteDocまたは1 Image Bufferである。何も開かない空Bufferも許す。

## 4. Keyboard-first

Editor、Tree、Outline、検索、Command-line、Tab、Windowはkeyboardだけで操作できる。
mouseはcaret配置、検索結果選択、外部link確認、画像resizeなどの補助操作に使えるが、
Treeの作成、並べ替え、親変更、rename用UIは提供しない。

Vimとの互換性は目的ではなく手段である。WYSIWYGの構造を安全に扱うため、Memoka独自の論理行、
Section、Table Cell、atomic node操作を定義する。互換操作と差異は
[Vim操作](vim-operations.md)に明記する。

## 5. ローカルファーストと同期可能性

通常操作ではWorkspaceの内容をnetworkへ送信しない。現行製品は外部同期serviceを提供しないが、
NoteDocがYjs updateで表現され、永続化とUIがCore transaction境界を共有するため、将来のtransportを
追加できる構造を保つ。

CRDTであることは無条件のmergeを意味しない。永続化revisionの競合、invalidなID、壊れたtree、
古いUI intentは検出して拒否し、データ欠落を避ける。

## 6. 現行製品に含めないもの

- 複数NoteDocを1画面へ連結するContinuous Notes
- persisted virtual root
- Note境界をまたぐmotion、selection、operator、Undo
- Markdown directoryを正本として通常起動時に双方向同期する仕組み
- Treeのdrag-and-drop、click open、inline rename
- realtime外部同期serviceとuser account
- plugin実行基盤
- Vimscript、Ex、register、macro、mapping全般の完全互換
- Attachmentの参照数0一覧、Trash、永続削除、CAS garbage collection
- Windows向けの公式署名済みbinary配布

非対応項目は将来予定を意味しない。実装されるまでは本仕様へ予定動作を追加しない。

## 7. Beta互換性

Memokaは開発中のbetaであり、保存data、設定、操作仕様を含む互換性を壊す変更を行うことがある。
変更時はmigrationまたは明示的な拒否を用意し、黙って別の意味として読み込まない。重要なWorkspaceは
portable mirrorに加えて外部toolで世代管理する。
