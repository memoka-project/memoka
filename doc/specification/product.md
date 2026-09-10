# プロダクト

[仕様書へ戻る](../specification.md)

## 1. コンセプト

Memokaは、Vimの操作感でMarkdownを意識せずサクサク書ける、keyboard-firstのローカルメモ帳である。
WYSIWYGな構造化Editorを使いながら、移動、選択、編集、Window操作をVimに近い一貫したkeyで行う。

主要な価値は次のとおりである。

- Markdown記号の手編集を必須にせず、Section、List、Table、Code、Link、Attachmentを直接編集できる。
- Namespace Treeでノートやグループを整理し、Note内はH6までのSectionで構造化できる。
- 通常の編集をローカルで完結させ、network障害や外部serviceに依存しない。
- 確定した正本と添付を自動履歴へ保存し、過去世代を参照・復旧できる。Markdownは必要時にCLIやClipboardから読み出せる。
- 同一Noteを複数Windowで開いても、CRDTを介して内容を即時に共有する。

## 2. 採用構成

- Desktop shellはTauri 2を使用する。
- EditorはTipTap / ProseMirrorを使用する。
- NoteDocとWorkspace metadataの共同編集表現にはYjsを使用する。
- 永続metadata、snapshot、update log、検索indexはSQLiteへ保存する。
- 添付bytesはSHA-256 content-addressed storageへ保存する。
- NamespaceはNoteと独立したWorkspace CRDT内の配置であり、Noteを持たないgroupも扱う。
- 履歴は固定版Resticを同梱し、local repositoryと任意の独立した追加repositoryへ保存する。
- Markdownはimport、Clipboard交換、Native CLIからの読み出しに使用し、通常編集の正本にはしない。

UI、Core、永続化の責務を分離する。UIは入力意図をtyped commandとしてCoreへ渡し、Coreがvalidationと
transactionを行う。検索index、title cacheなどの派生物はCoreで確定したrevisionを基準に更新する。
Nativeの共通Read Serviceは、現行DBとRestic世代の双方をDOMなしで読み出す。

## 3. Namespace TreeとSection tree

Namespace TreeとSection treeは異なる目的を持つ。

- Namespace TreeはEntryの発見、作成、順序変更、親変更、Trashを行うWorkspace projectionである。
- Section treeは1 NoteDoc内の本文構造であり、Editor、Outline、Focused Section、構造Clipboardの対象になる。
- Entryは親Entryを高々1つ持つ。live Noteの配置は1つだけで、Note自身に親・位置を保存しない。
- Noteなしgroupは独立したEntryであり、見せかけの空Noteやaliasではない。
- 親Noteを開いても子NoteDocを同じEditorへ連結しない。
- 1 Windowの編集対象は常に1 NoteDocまたは1 Image Bufferである。何も開かない空Bufferも許す。

## 4. Keyboard-first

Editor、Tree、Outline、検索、Command-line、Tab、Windowはkeyboardだけで操作できる。
mouseはcaret配置、検索結果選択、外部link確認、画像resizeなどの補助操作に使えるが、
Treeの作成、並べ替え、親変更はkeyboard commandで行う。Note titleはEditor、group nameはCommandから変更する。

Vimとの互換性は目的ではなく手段である。WYSIWYGの構造を安全に扱うため、Memoka独自の論理行、
Section、Table Cell、atomic node操作を定義する。互換操作と差異は
[Vim操作](vim-operations.md)に明記する。

## 5. ローカルファーストと端末間同期

通常の編集はローカルで完結する。同期を明示的に有効にしたWorkspaceだけ、LAN・VPN内の登録端末へ
直接接続し、Workspaceを開いている間に本文・構造・添付を自動統合する。オフライン編集も再接続時に引き継ぐ。
専用アカウントや固定の管理端末は不要で、任意の登録端末から追加・解除を行える。

CRDTであることは無条件のmergeを意味しない。並行した移動・削除は決定的に投影し、削除と編集が重なった
内容は復旧可能に保護する。不正ID、未知schema、破損update、端末内revisionの競合は検出して拒否する。
対象・直接通信・認証・移行と復旧の境界は[端末間同期](device-synchronization.md)を参照する。

## 6. 現行製品に含めないもの

- 複数NoteDocを1画面へ連結するContinuous Notes
- persisted virtual root
- Note境界をまたぐmotion、selection、operator、Undo
- Markdown directoryを正本として通常起動時に双方向同期する仕組み、旧mirrorの新規自動出力
- Treeのdrag-and-drop、inline rename
- 接続仲介・relay・保存型同期サーバーとuser account
- plugin実行基盤
- Vimscript、Ex、register、macro、mapping全般の完全互換
- Attachmentの参照数0一覧、Trash、永続削除、CAS garbage collection
- Windows向けの公式署名済みbinary配布

非対応項目は将来予定を意味しない。実装されるまでは本仕様へ予定動作を追加しない。

## 7. Beta互換性

Memokaは開発中のbetaであり、保存data、設定、操作仕様を含む互換性を壊す変更を行うことがある。
変更時はmigrationまたは明示的な拒否を用意し、黙って別の意味として読み込まない。重要なWorkspaceは
別媒体への追加バックアップを用意する。同じWorkspace内の履歴だけでは媒体故障やWorkspace全体の削除に備えられない。
