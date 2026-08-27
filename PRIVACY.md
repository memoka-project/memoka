# Privacy

Memokaはローカルファーストで動作し、テレメトリー、広告、クラッシュレポートの自動送信を行いません。
ノート本文、タイトル、検索語、Clipboard、添付ファイル、WorkspaceのパスをMemokaのサーバーへ送信しません。

配布版は起動後に更新の有無を確認するため、GitHub ReleasesのHTTPS endpointへ接続します。この通信では
GitHubへIPアドレス等の通常のHTTP接続情報が伝わり得ます。更新のdownloadとinstallは利用者が`:update`で
明示的に確定した場合だけ実行します。

診断ログはOS標準のMemoka log directoryへローカル保存され、最大5 MiBのファイルを3世代まで保持します。
ログは自動送信されません。共有する場合は利用者自身が内容を確認してください。
