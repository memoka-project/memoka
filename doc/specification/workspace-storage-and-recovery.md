# Workspace保存と復旧

[仕様書へ戻る](../specification.md)

## 1. データ領域

1つの利用者選択directoryを1 Workspaceのデータ領域とする。初回起動時に空directoryを選択する。
以後はapplication config directoryの`selected-workspace.json`へ選択pathだけを保存する。

データ領域直下の`.memoka/`が内部正本であり、次を保持する。

- SQLite database
- Workspace/Note Yjs snapshotとupdate log
- local Application Window state
- Attachment SHA-256 CAS
- materialized Attachment
- portable mirror staging
- Workspace process lock/activation情報

本文、Note metadata、添付metadataをapplication config directoryへ複製しない。

既存directoryを選ぶ場合、validなMemoka data areaか完全に空でなければ拒否する。
認識できないfileがある非空directoryを黙って初期化しない。

## 2. データ領域の切替

`:switch-workspace`でdirectory chooserを開く。切替前に現在WorkspaceのCore保存をflushし、
設定に従ってportable mirrorを確定する。

- 新しい領域を開けた場合だけselectionを更新する。
- validation、lock、load、migration、初期化に失敗した場合は元Workspaceへ戻る。
- `:data`、`:backup`、GUIの`:restore`は提供しない。

## 3. portable mirror

データ領域直下へ、人間可読Markdownと復旧用baselineを一方向に自動publishする。
専用の`backups/`directoryや世代管理機能は持たない。

```text
<data-area>/
├── .memoka/
├── memoka-manifest.json
├── Project.md
├── Project.notes/Child.md
├── Project.sections/Intro.md
├── memoka-trash/
├── memoka-attachments/
├── memoka-overflow/
└── memoka-recovery/
```

Markdown、directory名、filenameは内部正本から導出する。通常起動時にmirrorの外部編集を読み戻さず、
filesystem watcherによる双方向同期も行わない。

## 4. path投影

利用者に見えるdirectory/fileにはIDではなくNote title、Section title、Attachment original filenameを使う。
Note/Section/Attachment IDはmanifestと復旧metadataに保持する。

- 子Noteは親Note stemの`.notes/`以下へ置く。
- 子Sectionは親Section stemの`.sections/`以下へ置く。
- Root直接BodyはNoteの`.md`へ出力する。
- 非Root Sectionはそれぞれ固有の`.md`へ出力する。
- Internal LinkとAttachment参照は現在mirror内の相対pathへ変換する。
- rename/move後もidentityはmanifest IDで追跡し、次回publishでpathを再投影する。

path componentをNFCへ正規化し、path separator、control文字、Windows予約文字、末尾space/dot、
`.`、`..`、予約名をpercent escapeする。

- 空Note titleは「新しいノート」
- 空Section titleは「無題」
- case-insensitiveまたはNFC-equivalentなsibling衝突はtree順の2件目から` (2)`、` (3)`を付ける
- componentはUTF-8で180 byte以内
- relative pathが2,048 byteを超える場合はtitle path由来hashで`memoka-overflow/`へ投影

表示pathを内部identityとして逆利用しない。

## 5. 自動publish trigger

portable mirrorは次の時点で自動作成する。

- 最後の確定変更から10秒idle後
- 設定で待機する場合のApplication終了前
- Workspace切替前

起動しただけではmirrorを無条件生成しない。manifestに記録されたrevision/hashと内部正本が一致すればskipする。
通常の本文編集は変更Noteだけをdelta publishする。

title由来pathの変更、Note/Section tree変更、link再投影が必要な操作、manifest/managed fileの破損では、
pathとlinkの整合性を保つため全体を再構築できる。

外部toolが世代管理、遠隔copy、暗号化、snapshotを担当する。

## 6. 非同期生成

mirror生成はEditor入力と同期的に全Noteをserializeしない。

- frontendは確定Core revisionからSection/BodyChunk単位で生成し、event loopへyieldする。
- 編集再開でcommit前の古い生成をcancelし、最新revisionを後続queueへまとめる。
- Attachment bytesはfrontendへ戻さず内部CASからstagingへcopyする。
- transferは最大4 MiB chunkを使う。
- backendのhash、fsync、renameは通常のSQLite保存lockと分離する。
- native commit開始後は整合性のため完了させ、その後に新revisionをpublishする。

debug buildではwaiting、preparing、transferring、committing、errorと進捗をdebug lineへ表示する。

## 7. atomic publish

publish開始時にrootへ`.memoka-mirror-updating` markerを作りfsyncする。
`.memoka/portable-staging/<operation-id>/`で全fileを生成し、size/SHA-256を検証してから
同一filesystem内でmanaged fileをrenameする。

`memoka-manifest.json`を最後に公開し、旧manifestだけにあるmanaged fileを除去してmarkerを消す。
crash後のstagingは破棄するがmarkerを残し、次の完全publishで修復する。

symlink、root外path、hash/size不一致、manifest不整合をverify/restoreで拒否する。
外部backupをcopyする場合はMemoka終了後、またはmarkerがなくCLI verifyが成功する時点を使う。

## 8. 終了

確定編集の内部正本保存は必ず終了前にflushする。portable mirrorを待つかはapplication設定で選べる。

- 既定の`wait_for_mirror = true`では最新mirrorを確定してから終了する。
- 待機中は終了overlayへphaseと書込進捗を表示する。
- `false`では内部正本保存後すぐ終了し、mirrorを次回起動後の必要時に回す。
- flush失敗時は終了を中止して利用者へ通知する。

OS window close、`:quit`、`:q`、`:qa`は同じshutdown coordinatorを使う。

## 9. 同一Workspaceの排他

同じWorkspaceを通常利用するMemoka processは同時に1つだけにする。

起動時にdata areaのlockを取得する。既存processが同じWorkspaceを開いている場合、新processはWorkspaceを開かず、
既存processへactivationを通知してWindowを復元・前面化し、自身は終了する。

stale lockはprocess identityとplatform規則で検証し、実行中processのlockを勝手に奪わない。
異なるWorkspaceは別processで開ける。

## 10. 復旧CLI

復旧はGUI commandではなく、releaseに含む`memoka-cli`で行う。

```bash
memoka-cli verify --source <portable-mirror-data-area>
memoka-cli restore --source <portable-mirror-data-area> --target <empty-data-area>
```

`verify`はmarker、manifest schema、全managed fileのsize/SHA-256、path安全性、symlink、
case/NFC衝突を検証する。

`restore`はverify成功後、完全に新しい復旧先だけを受け入れる。overwrite、merge、sourceとtargetの同一指定、
既存`.memoka`/`.memoka-*`/`memoka-*`を含むtargetを拒否する。GUIが記憶する選択Workspaceは変更しない。

`memoka-recovery/`のWorkspaceMetadataDoc/NoteDoc baselineから次を復元する。

- Workspace/Noteをrevision 1、snapshot revision 1として保存
- Attachment metadataをSQLiteへ復元
- Attachment bytesをSHA-256 CASへ復元

旧update log、Undo history、FTS index、Application Window stateは復元しない。FTSは通常起動後に再構築する。
Markdownをparseして内部identityを推測せず、manifest IDと検証済みfresh Yjs baselineを使う。
