# Changelog

このプロジェクトは[Semantic Versioning](https://semver.org/)に従います。

## [Unreleased]

## [0.1.6] - 2026-09-05

- 空のNote／Section title表示を深さに応じたplaceholder色へ整え、巨大Noteではtitle用走査をSection構造だけに限定。Sectionを同階層へ貼り付ける構造操作も修正。
- 行番号の表示下限、Section／List／Code Block／Tableの共通indent幅、Replace modeの表示を設定可能にし、layout guideを整理。
- Normal modeの`W` / `B` / `E`と、単語motionを含む設定可能な`whichwrap`を追加。
- Obsidian形式の`==highlight==`とGitHub／Obsidian Alertの貼り付け、編集、表示に対応。
- `zo` / `zO` / `zc` / `zC` / `za` / `zA`によるWindow固有のSection折り畳みと、Outline・Note内検索との連携を追加。
- ListItemの論理行削除で未選択の子孫を保持し、Normal／Visual Line／Insert modeから表示順を保ったList深さ変更を行えるように変更。

## [0.1.5] - 2026-09-04

- 巨大Noteで表示範囲のrich textが素のtextへ切り替わる問題を修正。
- Insert modeの`Ctrl-c` / `Ctrl-h` / `Ctrl-j` / `Ctrl-m` / `Ctrl-u` / `Ctrl-w`と、Section深さを変更する`Ctrl-t` / `Ctrl-d`を追加。
- Paragraph上の`>>` / `<<`によるSection化・昇格と、直前のVisual選択を復元する`gv`を追加。
- 日本語の禁則処理と`w` / `b` / `e`の分割粒度を、表示用・操作用に個別設定できるよう変更。
- Normal modeでIMEがONのまま押された最初のcommand keyを保持し、IMEをOFFにしてからVim commandとして処理するnative連携を追加。

## [0.1.4] - 2026-09-03

- Section titleの日本語IME確定が本文へ移動または二重入力される問題を修正。
- `:q` / `:qa`による終了操作を追加。
- Nightfox系color theme、構文要素の配色、mode表示、Visual選択、List markerの視認性を整備。
- application全体のfontとzoom、中央寄せするNote最大幅を設定できるようにし、和欧混植とTableを含む文字表示を調整。
- `h/l`の論理行wrapを設定可能にし、Leader shortcutの名前空間を整理。
- Window分割時に同方向の既存Windowを含めて均等配置するよう変更。
- 先頭10件のTabPageに`1`〜`9`、`0`を表示し、`t1`〜`t9` / `t0`による直接移動を追加。
- AppImage生成pluginを上流のversioned ReleaseとSHA-256へ固定し、可変な`continuous` assetによるbuild失敗を解消。

## [0.1.3] - 2026-09-03

- AppImage生成pluginの上流asset更新によりRelease draftのbuildが失敗したため、GitHub Releaseは未公開。

## [0.1.2] - 2026-08-31

- GFM Table向けのVisual Block、Cell移動、行列操作、alignment変更、Undo、`.` repeatを含むkeyboard-first編集を追加。
- Tableの内部Clipboardに加え、HTML、GFM Markdown、TSVによる外部applicationとのcopy / pasteを追加。
- `/table`から行列数を選択できる10×10 gridを追加し、既定サイズを3列×3行に設定。
- Table内の`j/k`は列を保って移動し、先頭／最終行ではTable外の隣接論理行へ続くよう修正。
- README冒頭にbeta版と互換性変更の注意を追加し、wingetを使うWindows source build手順を整備。

## [0.1.1] - 2026-08-31

- Linux AppImage配布、更新、診断、native受入を準備中。
- AppImageがbuild hostのGLib / Wayland / GTK IME設定を強制し、新しいLinux環境で起動不能またはIME不通になる問題を修正。
- LinuxでWebKitGTKのpreedit表示を有効化し、IME変換中の未確定文字列が見えない問題を修正。
- 終了前の保存完了後にnative windowを破棄できず、保存失敗と誤表示される問題を修正。
- 終了時の正本保存、Markdown mirror、FTSの待機境界を分離。既定では進捗を表示してmirror完了を待ち、`config.toml`で次回起動後の生成へ回せるように変更。
- Memokaの二重起動を拒否し、新しいプロセスから既存Windowを復元・前面化するsingle-instance連携を追加。
- 起動時に正本と一致するMarkdown mirrorを再生成せず、通常の本文編集では変更Noteだけを差分更新するよう改善。

## [0.1.0] - 2026-08-30

- Vim風編集、Note Tree、再帰Section、Focused Section、検索、内部リンク、添付CASを実装。
- SQLite/YjsをSSOTとするWorkspaceデータ領域と、自動Markdown mirror、検証・復旧CLIを実装。
- 巨大NoteDoc向けBodyChunk、bounded editor、非同期paste・索引・mirrorを実装。
- Linux x86_64はTauri Updater署名付きAppImage、Windowsはsource codeのみを配布する方針を採用。

[Unreleased]: https://github.com/memoka-project/memoka/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/memoka-project/memoka/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/memoka-project/memoka/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/memoka-project/memoka/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/memoka-project/memoka/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/memoka-project/memoka/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/memoka-project/memoka/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/memoka-project/memoka/releases/tag/v0.1.0
