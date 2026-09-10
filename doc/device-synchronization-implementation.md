# 端末間同期の実装と検証記録

製品の契約と操作は[端末間同期の仕様](specification/device-synchronization.md)に記載する。
この記録は実装範囲と検証方法・実行環境を区別するためのものである。

## 実装範囲

- NoteDoc 7の安定IDごとの内容・配置・削除・観測済み復元、循環の決定的解消、H6表示補正、Table行列ID。
- 要素ごとのProseMirror adapter、相対カーソル、IME待機、ローカルUndo、Vim操作、分割Window、復旧画面。
- WorkspaceMetadataDoc 4のTree・Trash、削除された親への並行追加、GUI・CLI・検索・履歴の共通投影。
- SQLite 7への候補変換、移行前バックアップ、Markdown・装飾・構造・ID・添付hash比較、旧履歴読出し。
- owner transactionと一体のjournal、永続inbox、受信/反映frontier、署名、複数文書の原子的反映、checkpoint集約。
- 読出し専用snapshotによる準備とGUI保存queueへのpublication、応答消失時の再送、受信とTrashのIME待機。
- 添付の分割転送・耐久位置保存・途中再開・サイズ/hash検証・CAS公開・破損隔離・再試行、取得待ち表示。
- OS資格情報、署名付き登録/解除、期限付き一回限りの招待と確認鍵に束縛した明示承認。
- 手動宛先に限定するiroh/QUIC、自動接続・再送、別端末経由の認可と変更配送、解除前の編集のcheckpoint引継ぎ。
- 新しい空の保存先への初回受信と中断再開、ローカルHelp生成、`:sync-settings`、`:sync`、CLI状態取得。
- Replica IDに束縛したCLI編集、復旧時の同期・古いReplica・receipt消去、同期取得中のバックアップ保留。

仲介・relay・保存型同期サーバーは実装対象に含めない。将来のtransportは文書の統合判断を持たず、
同じengineへ接続する。配送Envelopeを内容から分離し、保存型transportを追加する場合の端末側暗号化・
受信端末ごとの鍵包装にはHPKE等の既存実装を使う。

## 自動検証

`corepack pnpm verify`は整形、仕様、lint、型、GUI/Core、release tools、rclone境界、Rust、CLI資料、buildをまとめて検証する。
追加した試験は通常のverifyへ含まれる。

| 対象             | 主な試験                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本文・構造の収束 | `tests/replicated-note.test.ts`、`tests/replicated-namespace.test.ts`で3Replica、逆順・重複配送、移動と本文編集、循環、削除と復元、List・Table・H6                |
| Editor           | `tests/replicated-note-adapter.test.ts`、`tests/replicated-note-product.test.ts`で通常Core、TipTap、Vim、複数Window、IME、相対位置、Undo                          |
| 復旧と画面反映   | `tests/replicated-note-recovery.test.tsx`、`tests/sync-publication.test.ts`で保護内容、rollback、SQL応答消失、IME開始の競合、WorkspaceだけのTrash、focus・DOM維持 |
| Help・設定・参加 | `tests/help-note.test.ts`、`tests/sync-settings.test.tsx`、`tests/sync-join.test.tsx`でHelp ID、本文の端末内生成、明示有効化、確認鍵、承認待ち、受信後のopen      |
| Rust/Yjs契約     | 双方向snapshot・編集delta fixture、共通reader、CLI編集・receipt、移行候補の比較                                                                                   |
| 永続性           | `src-tauri/src/replication/tests.rs`で送信直前・受信直後・複数文書反映・添付転送のfault注入、再起動、checkpointと未送信編集の統合                                 |
| ownerの境界      | `publication_tests.rs`で準備中のローカル保存、反映済みticket再送、Workspace/Replica切替、受信隔離、WorkspaceだけのTrash                                           |
| 認証             | `authorization_tests.rs`で期限、一回限り、鍵照合、署名付き中継登録、非連鎖解除、過去のgraphによる新規認可拒否                                                     |
| QUIC             | `direct_tests.rs`、`rpc_tests.rs`、`exchange_tests.rs`で鍵、Frame上限、巨大stream中の制御交換、双方向配送、再接続、添付再開とhash検証、待受けportの再利用         |
| 初回複製         | `join_tests.rs`で実際のQUIC承認・文書受信、新しい保存先だけを許可、同じ候補鍵での再開、秘密情報のDB除外                                                           |
| 移行・復旧       | Workspace migration、portable mirror、backupの試験で内容・ID・hash、WAL、失敗時の元DB不変、旧世代、復旧先の同期無効化                                             |

ネットワーク試験はLinux上のQUICループバック接続で実行する。OS資格情報は認証の単体試験ではMemoryCredentialsへ置き換える。

## 独立した検証ゲート

- `corepack pnpm large-note-replicated-gate`: NoteDoc 7の10 MiB／10万行の貼付け、入力、検索、保存・再起動。負荷が重ならないよう単独で実行する。
- `corepack pnpm sync-direct-network-gate`: Linux straceで、手動宛先へのUDP以外の送信がなく、探索・relay・portmapperを利用しないことを確認する。
- `MEMOKA_TAURI_APP=<検証用binary> corepack pnpm tauri:sync-e2e`: 同期設定を開いても待受けを開始せず、閉じた後に同じEditorとfocusへ戻ることをLinux WebKit/Tauriで確認する。
- `MEMOKA_TAURI_APP=<検証用binary> corepack pnpm tauri:e2e`: 分離した一時Workspaceを使うLinux WebKit/TauriのGUI回帰試験。

GUIのClipboard試験では、WebKitが内部MIMEを除いたTableRowもOSの優先形式から復元し、
HTMLのセル貼付けより先に構造として扱う。`tests/clipboard.test.ts`でも同じ経路とUndoを検証する。
内部リンクの表示名はtext子要素として保持する。GUIとRustの読出し・編集・移行で同じ形を許可し、
削除されたBlockに残るリンクも再起動後に復旧可能であることを試験する。

## 2026-09-10の実行結果

Linux x86_64環境で次を実行した。

- `corepack pnpm verify`: 成功。フロントエンド1,101件、Rust 271件、CLI 9件が通過した。通常実行から除外している大規模ノート試験は下記で別途実行し、既存の93世代Restic試験・10万Note FTS試験は手動試験として未実行である。
- `corepack pnpm large-note-replicated-gate`: 単独実行で成功。NoteDoc 7の10 MiB／10万行について、貼付け、DOM数、通常入力、検索、保存と再起動の判定を通過した。
- `corepack pnpm sync-direct-network-gate`: 成功。straceで35回のUDP送信を観測し、指定したループバック接続以外への送信がないことを確認した。
- `corepack pnpm tauri build --no-bundle`: リリースビルド成功。
- リリース版の`tauri:sync-e2e`: `TAURI_SYNC_SETTINGS_PASS`。既定無効、待受けなし、設定画面を閉じた後のEditor・focus維持を確認した。
- リリース版の`tauri:e2e`: 成功。Vim、OS Clipboard、Undo、分割Window、折返し行の移動、保存・再起動を確認した。約1 MiB／1,000段落・2 Windowの連続入力1,026回で入力から次の描画までのp95は16 ms、snapshot集約時は17 msで、既存の50 ms基準を通過した。この測定はLinux開発環境の参考値である。

## 実環境で残る確認

WindowsのGUI・実パケット、Windows/Linuxの実IME入力、LAN/VPNの異なる実端末間での通信は確認していない。
自動のcomposition event試験を実IMEの確認として扱わない。別OSの資格情報ストア、ネットワーク変更・firewall環境、
通常LANでの小さな確定編集の約1秒以内の反映も、対応する環境で確認する必要がある。

queueとメモリには仕様に記載した上限があり、超過を黙って欠落させず状態に表示する。
checkpointの生成失敗が通常差分の署名・配送を止めないよう処理を分離する。
同期の削除伝播はバックアップの代わりにならず、未取得の添付を含む新しい世代は取得完了まで保留する。
