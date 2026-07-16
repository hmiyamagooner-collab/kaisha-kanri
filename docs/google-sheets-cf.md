# Googleスプレッドシート → CF 同期

対象: [第３期GoonerCF](https://docs.google.com/spreadsheets/d/1d1LEQ_Mfjqm43r9wLkrqtsbdqWLl9Iyd7bgL6PATxUs/edit?gid=1995516463)

## 1. サービスアカウント作成

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成
2. **APIとサービス → ライブラリ** で「Google Sheets API」を有効化
3. **認証情報 → サービスアカウントを作成**
4. キー（JSON）を発行

## 2. スプシを共有

JSON の `client_email`（例: `xxx@xxx.iam.gserviceaccount.com`）を、対象スプレッドシートに **閲覧者** で共有する。

## 3. Vercel 環境変数

| 変数 | 内容 |
|------|------|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON の `client_email` |
| `GOOGLE_PRIVATE_KEY` | JSON の `private_key`（改行は `\n` のままで可） |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | `1d1LEQ_Mfjqm43r9wLkrqtsbdqWLl9Iyd7bgL6PATxUs` |
| `GOOGLE_SHEETS_GID` | `1995516463` |

ローカルは `api/secrets.local.js.example` を `secrets.local.js` にコピーして同様に記入。

## 4. 使い方

CF 画面 → **スプシから同期**  
→ 予定（CF予測）と月次出入りに反映。再同期で前回のスプシ取込分だけ置換。
