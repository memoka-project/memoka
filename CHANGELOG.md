# Changelog

このプロジェクトは[Semantic Versioning](https://semver.org/)に従います。

## [Unreleased]

- Linux AppImage配布、更新、診断、native受入を準備中。
- AppImageがbuild hostのGLib / Wayland / GTK IME設定を強制し、新しいLinux環境で起動不能またはIME不通になる問題を修正。
- LinuxでWebKitGTKのpreedit表示を有効化し、IME変換中の未確定文字列が見えない問題を修正。
- 終了前の保存完了後にnative windowを破棄できず、保存失敗と誤表示される問題を修正。
- 終了時の正本保存、Markdown mirror、FTSの待機境界を分離。既定では進捗を表示してmirror完了を待ち、`config.toml`で次回起動後の生成へ回せるように変更。
- Memokaの二重起動を拒否し、新しいプロセスから既存Windowを復元・前面化するsingle-instance連携を追加。

## [0.1.0] - 未公開

- Vim風編集、Note Tree、再帰Section、Focused Section、検索、内部リンク、添付CASを実装。
- SQLite/YjsをSSOTとするWorkspaceデータ領域と、自動Markdown mirror、検証・復旧CLIを実装。
- 巨大NoteDoc向けBodyChunk、bounded editor、非同期paste・索引・mirrorを実装。
- Linux x86_64はTauri Updater署名付きAppImage、Windowsはsource codeのみを配布する方針を採用。

[Unreleased]: https://github.com/memoka-project/memoka/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/memoka-project/memoka/releases/tag/v0.1.0
