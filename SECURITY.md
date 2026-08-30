# Security Policy

## Supported versions

公開後は最新の安定版だけにセキュリティ修正を提供します。

## Reporting a vulnerability

脆弱性を公開Issueへ記載しないでください。GitHubのPrivate vulnerability reportingを使い、
再現手順、影響範囲、確認したバージョンを添えて報告してください。受領後7日以内の初回応答を目標にします。

公式配布するLinux AppImageの更新artifactはTauri Updater署名を検証します。Windowsはコード署名済み
binaryを配布せず、source buildは自動更新の対象外です。署名鍵、Workspace、診断ログ、Clipboard内容を
Issueへ添付しないでください。
