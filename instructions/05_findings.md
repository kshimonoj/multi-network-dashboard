# 05_findings — Central / Mist 直接 API バックエンド基盤の調査結果

対象タスク: `instructions/05_direct_api_backend.md`
調査・実装日: 2026-07-23
実装先: `plugins/global-overview/`(サーバ側のみ。フロント UI は 06 番)

> **注意**: 本ファイルには認証情報の値そのものは一切記載しない。
> 形式・入手元・有効期限のみを記録する。実値は git 管理外の `.env` にある。

---

## Task 1: 認証情報の形式調査

### 1-1. HPE Aruba Networking Central

| 項目 | 内容 |
|---|---|
| 認証方式 | **OAuth2 client_credentials**(リフレッシュトークンは無い) |
| 入手元 | `~/claude/central-mcp-http/.env`(このファイル自体は変更していない。値を複製しただけ) |
| 必要な値 | `CENTRAL_BASE_URL` / `CENTRAL_CLIENT_ID` / `CENTRAL_CLIENT_SECRET` の 3 つ |
| ベース URL | `https://internal.api.central.arubanetworks.com`(新 Central / GreenLake 系。値は秘密ではないので記載) |
| トークン発行 | `POST https://sso.common.cloud.hpe.com/as/token.oauth2`<br>client_id / client_secret を **HTTP Basic** に載せ、body は `grant_type=client_credentials` |
| トークン形式 | `token_type=Bearer`、access_token は約 990 文字の JWT 相当文字列 |
| 有効期限 | **`expires_in = 7199` 秒(約 2 時間)**。実測値。失効したら同じ client_credentials で取り直す |
| 呼び出し時 | `Authorization: Bearer <access_token>` |

出どころの根拠: `central-mcp-server`(uvx 導入)が内部で使う `pycentral` の
`pycentral/base.py::NewCentralBase.create_token()` と
`pycentral/utils/constants.py::AUTHENTICATION["OAUTH"]` が上記フローそのもの。
本アプリはこれを TypeScript で再実装した(`plugins/global-overview/central-client.ts`)。

### 1-2. Juniper Mist

| 項目 | 内容 |
|---|---|
| 認証方式 | **API トークン 1 本**(OAuth ではない) |
| 入手元 | `~/.claude.json` の `mcpServers.mist-cloud.args`。`--header "Authorization: Bearer <token>"` として埋まっている |
| トークン形式 | 96 文字の英数字列 |
| 有効期限 | **無し**(Mist 側で明示的に失効させるまで有効。リフレッシュ手続きも無い) |
| ベース URL | `https://api.ac2.mist.com`(同じく `--header "X-Mist-Base-URL:..."` に入っている) |
| org_id | `<MIST_ORG_ID>`(`<MIST_ORG_NAME>`、role=`read`)。`GET /api/v1/self` の privileges から取得 |

**重要な発見 — スキームの読み替えが必要**:
`~/.claude.json` では MCP ゲートウェイ(`https://mcp.ai.juniper.net/mcp/mist`)向けに
`Authorization: **Bearer** <token>` として渡している。しかし **Mist 本体の REST API
(`api.ac2.mist.com`)は Bearer を受け付けず 401 を返す**。実測:

```
Authorization: Token  <token>  → HTTP 200
Authorization: Bearer <token>  → HTTP 401
```

→ 直接 REST では `Authorization: Token <token>` に読み替えて使う。
トークンの値そのものは MCP 用のものと同一で、ラップや再発行は不要だった。

### 1-3. 本アプリへの複製

`multi-network-dashboard/.env`(git 管理外。`.gitignore` に `.env` あり)に以下を追加した。
ひな形は `.env.example` にコメント付きで用意している(値は空)。

```
CENTRAL_BASE_URL / CENTRAL_CLIENT_ID / CENTRAL_CLIENT_SECRET / CENTRAL_TOKEN_URL
CENTRAL_RATE_PER_SEC / CENTRAL_RATE_BURST
MIST_BASE_URL / MIST_API_TOKEN / MIST_ORG_ID
MIST_RATE_PER_SEC / MIST_RATE_BURST / MIST_ALARM_WINDOW_SEC
GLOBAL_OVERVIEW_POLL_MS / GLOBAL_OVERVIEW_MIN_REFRESH_MS
```

`docker-compose.yml` の `environment:` にも同名で受け渡しを追加した。
`~/claude/central-mcp-http/.env` と `~/.claude.json` は**読み取りのみ**で、変更していない。

---

## Task 2: レート制限とポーリング設計

### 2-1. 実測したレート制限

**Central** — レスポンスヘッダで明示される(実測):

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1
```

→ **10 req / 1 秒**。この枠は **client_credentials(= アカウント)全体で共有**されるため、
同じ資格情報で動いている `central-mcp-http`(:8010 / cache-proxy :8011)とも取り合いになる。

**Mist** — レート制限ヘッダは**返さない**(`X-RateLimit-*` / `Retry-After` とも実測で不在)。
公開ドキュメント上の上限はトークンあたり 5000 req/hour とされるが、
API 応答からは確認できないため、本実装では確認済みの事実として扱わず保守的に設計した。

### 2-2. bulk エンドポイントへの寄せ(LPV 方針の踏襲)

trend 系・デバイス個別詳細は一切叩かず、**org / テナント一括の bulk だけ**で画面を作る。
1 巡につき出る HTTP は **Central 3 本 + Mist 3 本 = 6 本**(Central はトークン失効時のみ +1)。

| プラットフォーム | エンドポイント | 取れるもの |
|---|---|---|
| Central | `GET network-monitoring/v1/sites-health` | サイト一覧 / 位置(lat,lng) / health / devices.count / clients.count |
| Central | `GET network-monitoring/v1/devices?limit=1000` | 全デバイス(deviceType, status, siteName, model)→ AP/Switch/Gateway 台数と稼働状況 |
| Central | `GET network-notifications/v1/alerts?filter=status eq 'Active'` | Active アラート総数 + siteName 別内訳 |
| Mist | `GET /api/v1/orgs/{org}/stats/sites` | サイトごとの `num_ap`/`num_ap_connected`/`num_switch`/…/`num_clients`/`latlng` を **1 本で全部** |
| Mist | `GET /api/v1/orgs/{org}/stats/devices?type=all` | デバイス個体一覧(type/status/site_id) |
| Mist | `GET /api/v1/orgs/{org}/alarms/search` | 直近 24h のアラーム(総数 + site_id 別) |

**既知の落とし穴(`central-mcp-http/PATCHES.md` と同じ)**:
`sites-health` / `sites-device-health` / `sites-client-health` の 3 本は
`next` クエリパラメータを受け付けず、付けると
`400 HPE_GL_NETWORKING_ERROR_INVALID_QUERY_PARAMETER: Unknown query parameter: next` になる。
→ 本実装ではこれらに `next` を一切付けない(`limit=100` の 1 ページで足りる規模)。

**実測で判明した不整合(sites-health のアラート件数は使えない)**:
`sites-health` の `alerts.totalCount` は Active アラートの実態と一致しなかった。
実データで、Active アラートが立っているサイト(`<SITE_D>`)を `sites-health` は 0 と返した。
→ サイト別・全体とも `network-notifications/v1/alerts`(Active 絞り込み)を正とし、
`sites-health` の `alerts` は読み捨てる。この修正後、サイト行の合計とプラットフォーム総数が一致した。

### 2-3. 採用したポーリング間隔と根拠

| 設定 | 値 | 根拠 |
|---|---|---|
| `GLOBAL_OVERVIEW_POLL_MS` | **180000(3 分)** | 6 req / 180 s = **0.033 req/sec**。Central の枠 10 req/sec に対し平均 **0.33%**。指示された 1〜5 分の中央で、NetView 的な概況表示には十分な鮮度 |
| `GLOBAL_OVERVIEW_MIN_REFRESH_MS` | 60000(60 秒) | 手動 refresh の最短間隔。連打しても外部 API は叩かずキャッシュを返す |
| `CENTRAL_RATE_PER_SEC` / BURST | 4 / 4 | 10 req/sec の枠の **40% までしか使わない**。残り 60% を `central-mcp-http` 側に残す |
| `MIST_RATE_PER_SEC` / BURST | 2 / 2 | ヘッダで枠を確認できないため保守的に。3 req / 3 分 ≒ 60 req/hour |
| `MIST_ALARM_WINDOW_SEC` | 86400(24h) | アラーム集計窓 |

**central-mcp-http の TTL キャッシュとの関係**:
あちらは MCP ツール単位の TTL キャッシュ(`long_ttl` = 86400 秒 / `short_ttl` = 300 秒)を持つが、
本ダッシュボードは **cache-proxy も MCP サーバーも経由せず REST を直接叩く**ため、
キャッシュの重複・二重化は起きない。競合するのは「アカウント共有の 10 req/sec 枠」だけであり、
そこは上記の 4 req/sec 自主規制で分け合う。

### 2-4. 実装したレート制御(`plugins/global-overview/rate-limit.ts`)

1. **トークンバケット** — 平均 `ratePerSec`、バースト `burst`。取得は直列化して送出間隔を平滑化する。
2. **残枠の取り込み** — レスポンスの `X-RateLimit-Remaining` / `-Reset` を読み、
   残り 2 未満ならバケットを空にして reset 秒ぶん送出を止める。
3. **429 / 502 / 503 / 504 のリトライ** — `Retry-After` → `X-RateLimit-Reset` → 指数バックオフの順で待つ。最大 3 回。
   429 以外の 4xx は再試行しない(資格情報・クエリの誤りは待っても直らないため)。
4. **同時実行の抑止** — refresh は進行中の Promise を共有し、多重に走らない。
5. **可観測性** — 累計送出数・429 回数・待機合計 ms・直近残枠を `GET /api/global-overview/status` で公開。

---

## Task 3: 実装したもの

```
plugins/global-overview/
├── rate-limit.ts      … トークンバケット + 429 リトライ(Central/Mist 共通)
├── central-client.ts  … Central 直接 REST(OAuth2 トークンをプロセス内キャッシュ)
├── mist-client.ts     … Mist 直接 REST(Authorization: Token)
├── aggregate.ts       … 両者を 1 スナップショットに畳む。site-platform-map.json を流用
├── poller.ts          … 3 分ポーリング + メモリ/ファイルキャッシュ
└── api.ts             … Express router
```

`server/index.ts` に `/api/global-overview` としてマウント済み。

### エンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/global-overview/snapshot` | 集計済みスナップショット全体 |
| GET | `/api/global-overview/summary` | totals + platforms のみ(軽量) |
| GET | `/api/global-overview/sites` | サイト別内訳。`?platform=central\|mist` で絞り込み |
| GET | `/api/global-overview/status` | 資格情報の設定状況 / レート制御実績 / キャッシュ鮮度 |
| POST | `/api/global-overview/refresh` | 最短間隔を守った即時再取得 |

**GET はすべてキャッシュ読みで、外部 API を叩かない。** 外部に出るのはポーラーと `POST /refresh` だけ。

### サイト→プラットフォーム対応表の流用

`plugins/network-investigation/site-map.ts` の `readSiteMap()` をそのまま import して使う
(対応表の生成ロジックは複製していない)。用途は 3 つ:

1. **プラットフォーム帰属のラベル付け** — 対応表と同じ「Central / Mist は同一サイトを重複管理しない」前提を踏襲。
2. **位置情報の補完** — API 実データの lat/lng を優先し、欠けていれば対応表の値で埋める。
3. **突き合わせ** — API に出ないのに対応表にあるサイトを `siteMapOnly[]` として返す(対応表が古い兆候)。
   API にあって対応表に無いサイトは行ごとに `inSiteMap: false` が立つ。

### キャッシュ

メモリが一次、`data/global-overview/snapshot.json` に一時ファイル + rename で永続化する。
再起動直後は永続ファイルを読み戻し、鮮度が足りていれば **API を 1 本も叩かずに** 応答できる。
両プラットフォームとも取得に失敗した場合は既存キャッシュを壊さない(`site-map.ts` と同じ方針)。

### 注意点(データの意味)

- **Mist の Gateway 枠は `num_gateway` + `num_router` の合算**。Mist は SRX 等の Gateway と
  SSR(Router)を別カウントするが、NetView の表示区分に合わせて Gateway に寄せている。
- **Mist のサイト健全性スコアは `null`**。org スコープの bulk でスコアが返らず、
  SLE は別 API・別コストになるため、今回は取得していない(Central は 0-100 で入る)。
- **Central のアラートは Active 絞り込み、Mist は直近 24h のアラーム**。定義が異なる点は
  UI 側(06)でラベルを分けるのが望ましい。
- **Central のアラートは `siteName` でしかサイトに紐づかない**(応答に `siteId` フィールドが無い)。
- Central のアラートは `limit=100` が上限。100 件を超えると `total`(全体数)は正しいまま、
  サイト別内訳だけが先頭 100 件ぶんになる。

---

## Task 4: 動作確認の結果(実データ)

### 4-1. 疎通(ホストで直接実行、2026-07-23 05:02 JST 相当)

```
totals: sites=22  devices=54 (up 46 / down 8)  clients=26  alerts=16
devices: ap 14/17   switch 25/29   gateway 7/8
central: ok  sites=13  clients=16  alerts=2   HTTP 4 本(うち 1 本は初回トークン取得)
mist:    ok  sites=9   clients=10  alerts=14  HTTP 3 本
siteMapOnly: []   ← 対応表 22 件すべてが API 実データと突き合った
所要時間: 約 4.3 秒
```

サイト別内訳も 22 サイト分すべて取得できた(Central 13 / Mist 9)。
全サイトで `inSiteMap=true`、全サイトで緯度経度あり(06 の MAP 表示に使える)。

### 4-2. レート制限への抵触チェック

```
central: requests=4  throttled=0  waitedMs=246  lastLimit=10  lastRemaining=8
mist:    requests=3  throttled=0  waitedMs=499
```

- **429 は 0 回**。
- Central の残枠は最小でも 7〜8 / 10 で、枠を使い切っていない。
- `waitedMs` はトークンバケットが自ら送出を遅らせた時間。効いていることの裏付け。
- `POST /refresh` を 4 連打しても **追加の外部 HTTP は 0 本**(最短間隔ガードが機能)。

### 4-3. Docker

```
$ docker compose up -d --build     → Built / Started
$ curl localhost:8092/health
{"ok":true,"service":"multi-network-dashboard","port":8092,"ts":"2026-07-23T05:04:18.991Z"}
```

起動ログ:

```
[global-overview] 前回のスナップショットを読み込みました(2026-07-23T05:02:47.298Z)
[global-overview] ポーリング開始: 180s 間隔 / 1 巡につき HTTP 6 本
                  (Central 3 + Mist 3。Central の枠 10 req/sec に対し平均 0.3%)
```

コンテナ内から実 API を叩けることも確認:

```
$ curl -X POST localhost:8092/api/global-overview/refresh
central: ok requests=4 sites=13 clients=16 alerts=2
mist:    ok requests=3 sites=9  clients=10 alerts=14
throttled: central=0 mist=0
```

永続キャッシュが `./data`(バインドマウント)経由で引き継がれ、
**起動直後は外部 API を 1 本も叩かずに** `/summary` が応答した。

---

## 未対応 / 06 番以降

- フロントエンド UI(新タブ・Global Overview の MAP)は本指示書のスコープ外。
- Mist のサイト健全性スコア(SLE)は未取得。必要なら別 API を追加する(呼び出し数が増える)。
- Central の 100 件超アラートのページングは未実装(現状 2 件のため実害なし)。
- git 操作は行っていない。
