# Changelog

このプロジェクトは[Semantic Versioning](https://semver.org/)に従います。

## [Unreleased]

## [0.2.0] - 2026-09-07

- **互換性の変更:** WorkspaceをNamespace付きのデータモデルへ移行。更新前にアプリを閉じてデータ領域全体の外部バックアップを取り、移行後の領域を旧版で開かないでください。深さH6を超える既存Section等は移行前検査で停止します。
- Noteと整理専用Groupを分離したTreeを追加。常時Markdown mirrorを廃止し、MarkdownはClipboardとCLIの読み出しで出力。
- ResticによるWorkspace内の自動履歴、履歴プレビュー、GUIなしの読み出し・検索・履歴検証・復旧CLIを追加。
- パスワードと保持世代数（直近・日次・月次）が独立した複数バックアップ先、および保存先ごとの一時無効化に対応。
- Google Driveを実験的な追加バックアップ先として追加。公式AppImageとCLIへMemoka用Desktop OAuth client設定を組み込み、利用者によるJSON配置を不要に変更。Googleへの明示認証は必要。転送を優先し、内容検証と保持整理は後のアイドル時へ分離。
- 転送状況・検証待ち・工程別診断を拡充し、確認済みで変更のないbackup cycleの再走査と不要な転送worker起動を省略。
- 通常終了は確定編集のローカル保存後にバックアップを安全に中断し、完了を待たず未完了分を次回起動へ持ち越すよう変更。Workspace切替とUpdaterは従来どおり必要なバックアップを待機。
- バックアップ設定・終了準備等のダイアログを中央floating modalへ統一。日時は`YYYY/MM/DD HH:mm:ss`、過去のイベントは相対経過時間も併記。
- ユーザー向け`:help`を`doc/help.md`から取り込むよう変更し、カテゴリ別の現行仕様書を`doc/`へ整理。Carbonfoxの配色も調整。
- `doc/development`の開発記録から現行の契約・設定・検証条件をカテゴリ別仕様書へ統合し、開発記録を削除。
- Table候補の判定時、pipeを含まないplain textのMarkdown全文解析を省き、巨大貼り付けの同期処理を短縮。
- Windowsの子プロセス起動・終了待ち、Workspaceロック競合の識別、IPCの非同期データ待機、履歴復旧時のファイルhandle解放を修正。

## [0.1.8] - 2026-09-05

- 巨大なplain text貼り付けのUUID乱数生成をbatch化し、変更blockの再検索と通常文に対する不要なMarkdown全文解析を省いてLinux release gateを安定化。

## [0.1.7] - 2026-09-05

- Clipboard上の画像dataを貼り付け、画像blockを画像dataとしてyankできるようにし、外部applicationとの画像copy／pasteを強化。
- Note表示幅に対する画像幅をmouseまたはcommandで変更し、画像を現在Windowまたは新しいTabで開ける操作を追加。
- 画像の選択枠、resize handle、配置を整理し、通常時は画像だけを表示するように調整。
- WebKitGTKで空のListItemへ日本語入力を確定した際、ListItemが分割されて確定文字列の一部が重複する問題を修正。
- 巨大なplain text貼り付けを事前にBodyChunkへ分割し、不要なblock identity全走査を省いて処理時間とmemory使用量を削減。
- Linux release draftの巨大Note性能gateを安定して通過できなかったため、GitHub Releaseは未公開。

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

[Unreleased]: https://github.com/memoka-project/memoka/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/memoka-project/memoka/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/memoka-project/memoka/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/memoka-project/memoka/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/memoka-project/memoka/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/memoka-project/memoka/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/memoka-project/memoka/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/memoka-project/memoka/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/memoka-project/memoka/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/memoka-project/memoka/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/memoka-project/memoka/releases/tag/v0.1.0
