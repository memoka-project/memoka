# Memoka 仕様書

この文書は、同じGit revisionに含まれるMemoka実装の規範仕様への唯一の入口である。
固定の文書バージョンや更新日は持たず、仕様とソースコードを同じcommitで更新する。

Memokaは、Vimの操作感でMarkdownを意識せず高速に書ける、ローカルファーストのメモ帳である。
利用者が編集する正本はCRDT文書であり、Markdownは選択したデータ領域へ自動生成される可搬mirrorである。

## 仕様の読み方

この仕様書群には、現在の製品経路で実装されている契約だけを記載する。

- 「する」「しない」は現行実装が満たす規範的な動作を表す。
- 将来構想、未採用案、実装計画、判断過程は含めない。
- 内部実装を変更しても外部契約が変わらない場合は、仕様書を変更する必要はない。
- ユーザー操作、保存形式、設定、command、対応環境を変更する場合は、実装と同じcommitで対応カテゴリを更新する。
- コードと本文が矛盾している場合は不具合として扱い、どちらか一方を暗黙に正しいものとしない。

## 重要な不変条件

1. 1 Windowが編集するのは常に1つのNoteDocであり、親子Noteを連結編集しない。
2. Note TreeとNoteDoc内のSection treeは別の構造である。
3. SQLite、Yjs snapshot/update log、Attachment CASから成る内部データが正本である。
4. Markdown mirror、検索index、title cache、画面表示は正本から再構築できる派生物である。
5. 永続的な変更はCore transactionを通し、UIから保存層を直接変更しない。
6. Workspaceを通常利用するMemoka processは同時に1つだけである。
7. Clipboardはversion付きtransportであり、第二の永続データ源ではない。
8. Window、Tab、Sidebar、Focused Section、foldなどの表示状態はNoteDocの内容へ混入させない。

## カテゴリ

| カテゴリ                                                                     | 内容                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| [プロダクト](specification/product.md)                                       | コンセプト、対象範囲、用語、採用・非採用方針          |
| [アーキテクチャとデータモデル](specification/architecture-and-data-model.md) | Workspace、Note、Section、CRDT、schema、revision      |
| [コンテンツとEditor](specification/content-model-and-editor.md)              | block、論理行、Section、IME、大規模文書               |
| [Vim操作](specification/vim-operations.md)                                   | mode、motion、operator、Visual、Table、Tree、独自拡張 |
| [Application UI](specification/application-ui.md)                            | focus、Tab、Window、Buffer、Sidebar、Outline、表示    |
| [検索とリンク](specification/search-and-links.md)                            | Note内検索、Workspace検索、FTS、内部・外部リンク      |
| [Clipboardと添付](specification/clipboard-and-attachments.md)                | Clipboard形式、Markdown、Attachment CAS、画像         |
| [Workspace保存と復旧](specification/workspace-storage-and-recovery.md)       | データ領域、mirror、終了、排他、復旧CLI               |
| [設定とCommand](specification/configuration-and-commands.md)                 | config.toml、Leader、Command-line、外観設定           |
| [Platform、配布、Security](specification/platform-release-and-security.md)   | 対応OS、配布、Updater、privacy、diagnostics           |
| [検証](specification/validation.md)                                          | 自動試験、native手動確認、性能基準                    |

## 用語

- **Workspace**: 1つのデータ領域で管理するNote、添付、設定可能な表示状態の集合。
- **Note Tree**: Workspace内のNote間の1親階層とsibling順序。
- **NoteDoc**: 1 Noteの内容を保持するYjs文書。
- **Root Section**: NoteDocのroot。IDはNote IDと同一で、titleがNote titleになる。
- **Section**: Header、Body、Childrenを持つNote内の再帰構造。
- **block**: Paragraph、List、Table、Code Block、Imageなど、Section Body内の編集単位。
- **論理行**: Vimの行単位操作が対象とする行。画面幅による折り返しとは別である。
- **Focused Section**: Windowごとに表示対象として選んだSection subtree。
- **Buffer**: Windowに表示できるNote、Image、または空の参照。
- **portable mirror**: 人間可読Markdownと復旧データをデータ領域直下へ自動publishしたもの。
- **Core transaction**: validation、永続化、revision更新、派生処理の通知を一体で行う変更境界。

## 仕様更新の完了条件

仕様変更を伴う実装は、次をすべて満たした時点で完了とする。

1. 該当カテゴリに最終的な動作、境界、失敗時の扱いが記載されている。
2. 対応する自動試験またはnative手動確認条件が更新されている。
3. ユーザーが操作方法を知る必要がある場合は、管理Help Noteの内容も更新されている。
4. `corepack pnpm spec:check`と通常のrepository検証が通る。
