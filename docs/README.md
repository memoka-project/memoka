# Memoka 公開サイト

このディレクトリの内容を、そのままGitHub Pagesの公開ルートへ配置します。
ビルド、JavaScript、外部フォント、アクセス解析、アプリの起動は不要です。
相対リンクを使っているため、組織サイトのルートでもプロジェクトサイトの`/memoka/`以下でも動作します。

公開サイトはリポジトリ直下の`docs`で管理します。仕様書・ユーザーヘルプの`doc`とは別のディレクトリです。

| ファイル       | 用途                       |
| -------------- | -------------------------- |
| `index.html`   | ホームページ・アプリの紹介 |
| `privacy.html` | プライバシーポリシー       |
| `terms.html`   | 利用規約                   |
| `styles.css`   | 共通スタイル               |
| `icon.svg`     | Memokaのアイコン           |
| `.nojekyll`    | 静的ファイルとしての公開   |

## GitHub Pagesの公開元

GitHub側の設定やデプロイは、この変更では行いません。

1. 公開するブランチ（通常は`main`）にこの`docs`ディレクトリを反映します。
2. リポジトリの「Settings → Pages → Build and deployment」で、Sourceを「Deploy from a branch」にします。
3. 公開ブランチを選び、フォルダーを`/docs`にして保存します。

専用のビルドや公開用Workflowの追加は不要です。
[GitHub公式の公開元設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)を参照してください。

公開対象はこのディレクトリだけに限定してください。Workspace、OAuthクライアントJSON、トークン、パスワード、
診断ログなどを配置しないでください。OAuthクライアントJSONはサイト所有権確認用のファイルではありません。

## Google OAuthに設定するURL

このリポジトリのプロジェクトサイトとして公開する場合の例です。実際の公開先に合わせて変更してください。
`docs`は公開元のフォルダー名であり、公開URLには含まれません。

| 項目                 | URLの例                                                |
| -------------------- | ------------------------------------------------------ |
| ホームページ         | `https://memoka-project.github.io/memoka/`             |
| プライバシーポリシー | `https://memoka-project.github.io/memoka/privacy.html` |
| 利用規約             | `https://memoka-project.github.io/memoka/terms.html`   |

ホームページからリンクするポリシーと、同意画面に登録するポリシーは同じURLにします。
ログイン不要で3ページすべてを閲覧できることを、公開後に確認してください。
[Googleのブランド確認要件](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)も確認してください。

## Search Consoleの所有権確認

確認トークンはまだ配置していません。Google Search Consoleで発行されたものを使います。

- HTMLファイル方式：指定された名前・内容の確認ファイルを、Search Consoleが指定する公開URLで配信します。
- HTMLタグ方式：発行された`google-site-verification`のmetaタグを、対象ホームページの`<head>`に追加します。`index.html`内に追加位置のコメントがあります。

`https://memoka-project.github.io/`の所有権を確認する場合、確認ファイルやタグはそのルートで配信する必要があります。
`/memoka/`だけへの配置ではルートの所有権確認にはなりません。組織サイトの
`memoka-project.github.io`リポジトリ側に配置するなど、確認対象と配信URLを一致させてください。
確認後もファイル・タグを削除しないでください。
[Googleのサイト所有権確認](https://support.google.com/webmasters/answer/9008080?hl=ja)を参照してください。

## 文書の更新

法的文書の本文の正本は、リポジトリ直下の[PRIVACY.md](../PRIVACY.md)と[TERMS.md](../TERMS.md)です。
変更した場合は、対応するHTMLの`article[data-policy-source]`内の本文・更新日・目次も同時に更新してください。
Markdown内の相互リンクは公開HTML同士の相対リンクにし、ライセンスやSecurity PolicyはGitHubの公開文書へリンクします。

```bash
corepack pnpm exec prettier --check docs tests/public-pages.test.ts PRIVACY.md TERMS.md
corepack pnpm exec vitest run tests/public-pages.test.ts
```

テストでは本文・見出し・装飾・リンクのMarkdownとの一致、相対リンクの解決、JavaScriptや外部リソースを必要としないことを確認します。
ページ公開後のURL疎通、Search Consoleの所有権確認、Google OAuthの審査は別途必要です。
