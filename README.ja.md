[English version here / 英語版はこちら](README.md)

# multi-network-dashboard

**HPE Aruba Networking Central** と **Juniper Mist** で管理しているネットワークを、
1 つの画面から横断的に見るためのセルフホスト型ダッシュボードです。

もともとは Corstack の `network-investigation` プラグインでした。プラグインの中に
ポーリング・永続化・UI の関心が溜まってきたため、独立した Docker アプリとして外出しし、
その上に Global Overview / Webhook ログ / Central Streaming を追加したものが本リポジトリです。

## 機能

UI はタブ構成で、各タブが `plugins/` 配下の独立したプラグインに対応します。

### ネットワーク調査 (`plugins/network-investigation`)

自然文で質問する(「サイト X の健全性とアラートを確認して」など)と、バックエンドが
Central / Mist の MCP サーバーに対して Claude CLI を実行し、ツール呼び出しと回答を
SSE でストリーミングして返します。

- サイト → プラットフォームの対応表を持ち、Central だけの質問で Mist の MCP を起動しない(narrowing)
- スレッド形式の履歴、セッション単位の共有(Markdown / プレーンテキスト / メール)
- 回答内のグラフ・Mermaid 図・トポロジ描画
- 定期実行(cron)。結果は調査履歴に追記される

### Global Overview (`plugins/global-overview`)

Central / Mist の REST API を直接叩き(MCP を経由しない)、プラットフォーム横断の
サマリを表示します。サイト別の健全性、デバイス数・クライアント数、Active アラート、
および Leaflet 地図上のサイトピン。サイトをクリックすると、SLE 指標・デバイス表・
接続クライアント・アラート・イベントの詳細ページが開きます。

両クライアントともレート制限をかけています(Central の枠はアカウント全体で共有のため、
本アプリは意図的に一部しか使いません)。ポーリング結果はディスクにキャッシュされるので、
UI 側から外部 API を叩き散らすことはありません。

### Webhook ログ (`plugins/webhook-feed`)

Central / Mist の Webhook を Google Apps Script が受け、Google スプレッドシートに
書き込みます。本タブはそのシートをサービスアカウントで読み取り、統合されたフィードとして
フィルタ付きで表示します。重大アラートについては、ネットワーク調査プラグインによる
自動事前調査を任意で発火させられます。

Webhook の受け口自体は別リポジトリにあります:
**[central-mist-webhook-to-google-sheets](https://github.com/kshimonoj/central-mist-webhook-to-google-sheets)**
— このタブにデータを流すには、先にそちらをセットアップしてください。

### Central Streaming (`plugins/central-streaming`)

Central Streaming API に WebSocket で購読し、protobuf の CloudEvents
(AP monitoring / AP events / audit trail / geofence / location / location analytics)を
デコードしてライブフィードとして表示します。site_id は Global Overview のスナップショットから
名前に解決するため、追加の HTTP は発生しません。

## 必要なもの

- Docker / Docker Compose
- Claude Code の OAuth トークン(`claude setup-token`)— 調査プラグインが `claude` CLI を起動するため
- Central の API 資格情報(OAuth2 client credentials)および / または Mist の API トークン
- 任意: Webhook 用スプレッドシートへの閲覧権限を持つ Google サービスアカウント

## セットアップ

```bash
cp .env.example .env      # 値を記入する
docker compose up -d --build
# http://localhost:8092
```

資格情報はイメージに焼き込みません。`.env` / `secrets/` / `data/` はいずれも
`.gitignore` と `.dockerignore` で除外され、実行時にマウントされます。

### 環境変数

変数名のみを記載します(注記は `.env.example` を参照)。値はコミットしないでください。

| 変数 | 用途 |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude CLI の認証 |
| `NETINV_MODEL` | 調査エージェントの既定モデル |
| `CENTRAL_BASE_URL` | Central API のベース URL |
| `CENTRAL_CLIENT_ID` | Central OAuth2 の client id |
| `CENTRAL_CLIENT_SECRET` | Central OAuth2 の client secret |
| `CENTRAL_TOKEN_URL` | Central のトークンエンドポイント |
| `CENTRAL_RATE_PER_SEC` / `CENTRAL_RATE_BURST` | Central 側のクライアントレート制限 |
| `MIST_BASE_URL` | Mist API のベース URL |
| `MIST_API_TOKEN` | Mist の API トークン |
| `MIST_ORG_ID` | Mist の組織 ID(省略時は起動時に解決) |
| `MIST_RATE_PER_SEC` / `MIST_RATE_BURST` | Mist 側のクライアントレート制限 |
| `MIST_ALARM_WINDOW_SEC` | Mist アラーム集計窓 |
| `GLOBAL_OVERVIEW_POLL_MS` | Global Overview のポーリング間隔 |
| `GLOBAL_OVERVIEW_MIN_REFRESH_MS` | 手動更新の最短間隔 |
| `WEBHOOK_LOG_SPREADSHEET_ID` | Webhook ログのスプレッドシート ID |
| `WEBHOOK_LOG_SA_KEY_FILE` | サービスアカウント JSON 鍵のパス |
| `WEBHOOK_FEED_POLL_MS` | Webhook ログのポーリング間隔 |
| `WEBHOOK_FEED_MIN_REFRESH_MS` | 手動更新の最短間隔 |
| `WEBHOOK_FEED_AUTO_ENABLED` | 自動事前調査の有効/無効 |
| `WEBHOOK_FEED_AUTO_MAX_PER_CYCLE` | コスト上限: 1 ポーリングあたりの調査件数 |
| `WEBHOOK_FEED_AUTO_MAX_AGE_MS` | この時間を超えた行では発火しない |

## ディレクトリ構成

```
server/       Express のエントリポイント。各プラグインの router をマウントする
src/          アプリシェル(タブ・テーマ)
plugins/      機能ごとに 1 ディレクトリ。<plugin>/view/ が React 側
instructions/ タスク仕様とタスクごとの findings(調査記録)
data/         実行時の状態・キャッシュ(git 管理外)
secrets/      サービスアカウント鍵(git 管理外)
```

実行時の状態は DB ではなく `data/` 配下のファイルとして持ちます。各ファイルの
書き手は 1 つだけで、導出データ(サイト対応表・ステータスキャッシュ・スナップショット)は
いつでも Central / Mist から再生成できます。

## 開発

```bash
npm install
npm run dev        # server/index.ts を tsx watch
npm run typecheck
npm run build
```

## 備考

`instructions/` には、各機能を作ったときのタスク仕様と findings(調査記録)を残しています。
上流に文書化されていない API の癖もここに書かれています。これらの記録に含まれていた
実際のサイト名・デバイス識別子・テナント ID は、`<SITE_A>` や `<CENTRAL_SITE_ID>` の
ようなプレースホルダーに置換済みです。
