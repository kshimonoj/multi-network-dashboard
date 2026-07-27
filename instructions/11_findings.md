# 11_findings — サイト別詳細情報(Health/SLE・クライアント・デバイス・Alert/Event)の追加

対象タスク: `instructions/11_site_detail_panel.md`
調査・実装日: 2026-07-24
実装先: `plugins/global-overview/`(バックエンド + View。オンデマンド取得)

> 認証情報の値そのものは記載しない。REST の実測は git 管理外の `.env` の資格情報で行った。
> 調査は Central=`Home`(siteId <CENTRAL_SITE_ID> / 4 デバイス / 13 クライアント)、
> Mist=`<SITE_A>`(siteId <MIST_SITE_ID> / 4 AP / 5 クライアント)に対して実施。

---

## Task 1: 利用可能な API の調査(REST 実測)

**方針**: ダッシュボードは MCP を経由せず Central/Mist の REST を直接叩く(05 番の設計)。
そこで MCP ツールではなく **実際の REST エンドポイントの形を実測**して確定した。

### 1-1. HPE Aruba Networking Central(新 Central / GreenLake 系)

| 情報 | エンドポイント | 取得可否 | 主なフィールド |
|---|---|---|---|
| Health | `GET network-monitoring/v1/sites-health?filter=siteName eq '<name>'` | ✅ | `health.groups`(Poor/Fair/Good の %)→ 05 と同じ加重平均で 0-100。**SLE 内訳は Central には無い**(groups のみ) |
| クライアント | `GET network-monitoring/v1/clients?site-id=<siteId>&limit=100` | ✅ | `macAddress` `clientName` `clientOperatingSystem` `wirelessBand` `wirelessChannel` `snr` `wlanName` `status` `ipv4` `connectedTo`(接続先AP名) `connectedDeviceType` `clientManufacturer` `role` `connectedAt` |
| デバイス個別 | `GET network-monitoring/v1/devices?filter=siteId eq '<siteId>'&limit=100&next=1` | ✅ | `serialNumber` `deviceName` `deviceType` `model` `status`(ONLINE等) `firmwareVersion` `uptimeInMillis` `ipv4` `macAddress` `lastSeenAt` `partNumber` `configStatus` |
| Alert | `GET network-notifications/v1/alerts?filter=status eq 'Active'&limit=100` → `siteName` でクライアント側フィルタ | ✅ | `severity` `category` `summary` `createdAt` `deviceType` `type` `rootCause` `status` `priority` `siteName` |
| Event | — | ❌ **取得不可** | `network-monitoring/v1/events` / `network-notifications/v1/events` はいずれも **404 Route Not Found**。新 Central のこの API 面に Event を返す route が存在しない |

**確定したパラメータの癖(実測)**:
- クライアントは `site-id`(**kebab-case**)を受け付ける。`site_id` は `400 Query parameter must be in kebab-case`。
- デバイスは `site-id` を受け付けない(`400 Unknown query parameter`)。代わりに `filter=siteId eq '<id>'`(camelCase、クォートは有無どちらでも可)で site 絞り込みできる。
- アラートは **`siteName` / `siteId` での filter が不可**(`Filtering on field "siteName" is not supported`)。
  → Active アラートを 1 本取得し、`siteName` でクライアント側フィルタする(現状 org 全体で 2 件のため実害なし)。
- `network-monitoring/v1/clients` に `filter=siteName eq …` も不可(`invalid`)。site 絞り込みは `site-id` のみ。

**Central 1 サイトあたりの HTTP 本数**: **4 本**(sites-health / clients / devices / alerts)。トークンは約 2 時間キャッシュ済みなので追加取得は基本 0。

### 1-2. Juniper Mist

| 情報 | エンドポイント | 取得可否 | 主なフィールド |
|---|---|---|---|
| Health/SLE | `GET api/v1/orgs/{org}/insights/sites-sle?start&end` → `results` を `site_id` で引く | ✅ **取得可**(05/06 の「null」を解消) | `roaming` `capacity` `throughput` `coverage` `time-to-connect` `successful-connect` `ap-health`(各 0-1) `num_aps` `num_clients`。**org 一括で全サイト分が 1 本で返る** |
| クライアント | `GET api/v1/sites/{siteId}/stats/clients?limit=100` | ✅ | `mac` `os` `manufacture` `ip` `ap_mac` `ssid` `band` `channel` `rssi` `snr` `tx_rate` `rx_rate` `uptime` `proto` `vlan_id` `hostname` |
| デバイス個別 | `GET api/v1/sites/{siteId}/stats/devices?type=all&limit=100` | ✅ | `name` `type`(ap/switch/gateway) `model` `status`(connected等) `version` `uptime` `mac` `num_clients` `ip` `cpu_util` `mem_*` |
| Alarm | `GET api/v1/sites/{siteId}/alarms/search?start&end&limit=100` | ✅ | `severity` `type` `timestamp` `last_seen` `hostnames` `aps` `count` `group` |
| Event | `GET api/v1/sites/{siteId}/devices/events/search?start&end` | ✅ | `timestamp` `type` `device_type` `text` `mac` `ap`。(`clients/events/search` もあるが今回はデバイスイベントのみ採用) |

**確定した点(実測)**:
- **Mist の SLE スコアは取得できる**。05/06 では「org bulk では返らない」として null にしていたが、
  `orgs/{org}/insights/sites-sle` は org 一括で全サイトの SLE を返す。詳細パネルではこれを使って健全性を表示する。
  総合スコアは 7 指標(roaming/capacity/throughput/coverage/time-to-connect/successful-connect/ap-health)の平均 ×100 とする。
- `sle/site/.../summary` 系の site スコープ URL は 404(この org/API 版では site-sle は org insights 経由)。
- devices/clients/alarms は **site スコープの URL**(`sites/{siteId}/…`)で個別取得できる。

**Mist 1 サイトあたりの HTTP 本数**: **5 本**(sites-sle / clients / devices / alarms / device-events)。
sites-sle は org 一括だが 1 サイト表示につき 1 本として数える。

### 1-3. レート制限への影響(Task 1-5)

| | 常時ポーリング(既存・22 サイト) | 詳細パネル 1 回(オンデマンド) |
|---|---|---|
| Central | 3 本 / 3 分 | **+4 本**(その 1 サイトを開いたときだけ) |
| Mist | 3 本 / 3 分 | **+5 本**(その 1 サイトを開いたときだけ) |

- 詳細取得は **ポーラー(`poller.ts`)には一切組み込まない**。パネルを開いた時だけ発火する。
- Central の枠は 10 req/sec(アカウント共有)。詳細 4 本を既存の 4 req/sec 自主規制の下で出しても約 1 秒で捌け、枠を圧迫しない。
- 同一サイトを短時間に連続で開いても効かないよう、**30 秒の短時間キャッシュ + in-flight 共有**を設ける(Task 2-4)。
- 各セクションは独立に取得し、片方が失敗してももう片方は表示する(`Promise.allSettled`)。取得失敗は `error`、
  そもそも当該プラットフォームに無い情報(Central の Event)は `available:false` として **エラーと欠損を区別**する(05/08 の方針踏襲)。

---

## Task 2: バックエンド API 設計・実装

新設エンドポイント: **`GET /api/global-overview/site-detail?platform=<central|mist>&siteId=<id>&siteName=<name>`**

- `plugins/global-overview/site-detail.ts`(新規)… オンデマンド取得のオーケストレーション + キャッシュ。
- `central-client.ts` / `mist-client.ts` に `getSiteDetail()` を追加(Task 1 の各エンドポイントを叩く)。
- `detail-types.ts`(新規)… 共有型。セクションは `ok / error / unavailable` の 3 状態(欠損とエラーを区別)。
- `poller.ts` に `getClients()` を追加し、詳細取得がポーラーと**同じクライアント実体**(トークンキャッシュ・レートリミッタ)を共有するようにした。
- `api.ts` にルート追加。

**ポーラーには組み込んでいない**(Task 2-2)。`startPolling()` / `doRefresh()` は無改変で、
詳細は行/ピンのクリック時のみ `site-detail` が発火する。起動ログの「1 巡につき HTTP 6 本」は変わらず。

**呼び出し過多のガード**(Task 2-4):
- 30 秒の短時間キャッシュ(`GLOBAL_OVERVIEW_DETAIL_TTL_MS`、既定 30000)。同一サイトを連続で開いても API を叩き直さない。
- in-flight 共有(同じサイトへの同時要求を 1 本にまとめる)。
- 実測: 同一サイトを即座に 2 回開くと 2 回目は `cached:true` で HTTP 追加 0 本。

**エラーと欠損の区別**(Task 2-3):各セクションは `Promise.all` で独立取得し、失敗は `status:"error"`+理由、
当該プラットフォームに無い情報(Central の Event)は `status:"unavailable"`。null 値は既存方針どおり「—」表示。

## Task 3: フロントエンド詳細パネル

- `view/SiteDetailPanel.tsx`(新規)… 右からのスライドインパネル。Health/SLE・デバイス(AP/Switch/Gateway 別)・
  接続クライアント・アラート・イベントのセクションを 1 画面スクロールで表示。Esc / オーバーレイクリックで閉じる。
- `view/detailTypes.ts`(新規)… サーバ型のミラー。
- `view/api.ts` に `fetchSiteDetail()` を追加。
- `view/GlobalOverview.tsx` … `onPick`(テーブル行クリック **と** 地図ピンクリックの両方が経由する既存ハンドラ)で
  `detailTarget` をセットしてパネルを開くようにした → **行クリック・ピンクリックの両方から同じパネルに到達**(Task 3-3)。
- `view/styles.css` に `.go-dp-*` を追加(theme.css の変数のみ使用 → ダーク/ライト両対応)。
- ローディング表示・取得失敗時の赤枠インラインエラー(08 のパターンに準拠)。

## Task 4: 動作確認(実データ・Docker コンテナ :8092)

`docker compose up -d --build` で反映。`/health` → `{"ok":true,...,"mcpConfig":{"source":"live",...}}`。

### 4-1. エンドポイント実測(コンテナ経由)

| サイト | HTTP | health | devices | clients | alerts | events |
|---|---|---|---|---|---|---|
| Central `Home` | 4 本 | ok score=87(Poor13/Fair0/Good87) | ok 4 | ok 13 | ok 0(Active) | **unavailable**(route 無し) |
| Mist `<SITE_A>` | 5 本 | **ok score=94**(SLE 7 指標) | ok 7 | ok 3 | ok 1(過去24h) | ok 50(デバイスイベント) |
| Mist `<SITE_B>` | 5 本 | ok score=null(SLE データ無し→「—」) | ok 9 | ok 0 | ok 1 | ok 多数 |

### 4-2. 画面表示(ブラウザ実機・両テーマ)

- **Central `Home`(ライト)**: Health 87 + Poor/Fair/Good バー、AP/Gateway 別デバイス表(モデル/状態/FW/稼働/IP)、
  クライアント 13 件(OS/SSID/帯域/SNR/IP/接続先AP)、アラート「なし」、イベント「Event を返す route がありません」注記。
- **Mist `<SITE_A>`(ダーク)**: Health **94** + SLE 7 指標バー(Coverage95/Capacity86/Throughput93/Roaming84/
  TimeToConnect97/SuccessfulConnect100/APHealth100)、AP/Switch/Gateway 別デバイス表(AP には配下クライアント数列)、
  クライアント 4 件(帯域は "2.4 GHz" と正規化表示)、アラート/イベント表示。
- **Mist `<SITE_B>`(ダーク)**: SLE データが無く score「—」・各指標「—」で欠損をそのまま表示(エラーにしない)。
  Switch/Gateway デバイス、切断中の EX4300-VC を赤ドットで表示、イベント(SW_PORT_UP/DOWN 等)表示。
- 行クリック・地図ピンクリックの両方から同一パネルが開くことを確認。

### 4-3. レート制限への影響

- **常時ポーリングは不変**: 起動ログ「180s 間隔 / 1 巡につき HTTP 6 本」、`/status` の `pollIntervalMs=180000` は変化なし。
- **詳細 1 サイトあたりの追加 HTTP**: Central 4 本 / Mist 5 本(パネルを開いた時だけ)。
- **30 秒キャッシュ**の実測: 2 回目の同一サイト要求は `cached:true`・HTTP 追加 0。
- `/status` の `rateLimit.central.throttled=0` / `mist.throttled=0`(429 は 0 回)。
- 不正リクエストは 400(未知の platform / siteId 欠落)、未設定プラットフォームは 503 を返す。

---

## 変更・追加ファイル一覧

```
plugins/global-overview/detail-types.ts              新規 … 詳細の共有型(3 状態のセクション)
plugins/global-overview/site-detail.ts               新規 … オンデマンド取得 + 30s キャッシュ + in-flight 共有
plugins/global-overview/central-client.ts            getSiteDetail() 追加(health/clients/devices/alerts)
plugins/global-overview/mist-client.ts               getSiteDetail() 追加(sle/clients/devices/alarms/events)
plugins/global-overview/poller.ts                    getClients() を公開(クライアント実体の共有)
plugins/global-overview/api.ts                       GET /site-detail ルート追加
plugins/global-overview/view/detailTypes.ts          新規 … サーバ型のミラー
plugins/global-overview/view/SiteDetailPanel.tsx     新規 … スライドイン詳細パネル
plugins/global-overview/view/api.ts                  fetchSiteDetail() 追加
plugins/global-overview/view/GlobalOverview.tsx      onPick でパネルを開く(行/ピン共通)
plugins/global-overview/view/styles.css              .go-dp-* を追加(両テーマ対応)
```

`npm run typecheck` / `vite build` 通過。git 操作は行っていない。

## 既知の制約・注意

- **Central は Event を取得できない**(新 Central のこの API 面に route が無い。404)。UI は `unavailable` として明示。
- **Mist の SLE は取れないサイトがある**(AP が無い/クライアント 0 の Switch 主体サイト等)。その場合 score は null=「—」。
  05/06 で「Mist は健全性を返さない」としていたが、**org insights/sites-sle 経由で AP のあるサイトは取得できる**ことが判明。
- Central アラートは `siteName`/`siteId` で filter できないため、Active を 1 本取ってクライアント側で絞る(現状 org 全体 2 件で実害なし。100 件超でサイト別が欠ける可能性は既存 05 と同じ)。
