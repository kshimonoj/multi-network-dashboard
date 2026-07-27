# 12_findings — Central Event 調査 / クライアント一覧 / クライアント詳細 / ポーリング間隔設定化

対象タスク: `instructions/12_events_clients_polling.md`
調査・実装日: 2026-07-24
実装先: `plugins/global-overview/`(バックエンド + View)

> 認証情報の値そのものは記載しない。REST の実測は git 管理外の `.env` の資格情報で、
> 稼働中コンテナ(`multi-network-dashboard` :8092)内の env を使って行った。
> 調査サイト: Central=`Home`(siteId `<CENTRAL_SITE_ID>`)、Mist=`<SITE_A>`(siteId `<MIST_SITE_ID>`)。

---

## Task 1: Central Event 情報の取得可否調査 → **取得可能(11 番の「取得不可」を訂正)**

### 結論

**Central の Event は取得できる。** 11 番では「新 Central のこの API 面に Event を返す route が無い(404)」と
結論づけていたが、これは **誤ったパスだけを試した**ことによる誤判定だった。

- 11 番が試したパス: `network-monitoring/v1/events` / `network-notifications/v1/events` → いずれも **404 Route Not Found**(これは今回も再確認)。
- 正しいパス(developer.arubanetworks.com の **eventlistv1**): **`GET network-troubleshooting/v1/events`** → **200 で取得可能**。

`.env` の `CENTRAL_BASE_URL` は既に **`https://internal.api.central.arubanetworks.com`**(内部ホスト)で、
11 番の他情報(health/clients/devices/alerts)取得に現に成功している。したがって
タスクが挙げた 2 つ目のホスト `internal.api.central.arubanetworks.com/network-troubleshooting/v1/events` は、
**我々が既に使っている同一ホスト上の同一エンドポイント**であり、認証拒否(401/403)は発生しなかった。

### エンドポイント仕様(実測で確定)

`GET network-troubleshooting/v1/events`

**必須クエリパラメータ(すべて kebab-case。camelCase は 400 `Query parameter must be in kebab-case`)**:

| パラメータ | 値 | 備考 |
|---|---|---|
| `context-type` | `SITE` / `ACCESS_POINT` / `SWITCH` / `GATEWAY` / `WIRELESS_CLIENT` / `WIRED_CLIENT` / `BRIDGE` | 文脈の種類 |
| `context-identifier` | siteId / デバイス serial / クライアント MAC | context-type に対応する識別子 |
| `site-id` | siteId | **これも同時に必須**(context と併記) |
| `start-at` | RFC3339(ミリ秒付き UTC、例 `2026-07-24T00:04:57.384Z`) | |
| `end-at` | 同上、start-at より後 | **end-at − start-at < 30 日**の制約 |
| `limit` | 1–1000(既定 100) | |

- 必須のうち **1 つでも欠けると `400 HPE_GL_NETWORKING_ERROR_BAD_REQUEST`**(汎用メッセージで、どのパラメータが欠けたかは示さない)。
- 上記 6 個を全部揃えると 200。**サイト単位フィルタは `context-type=SITE` + `context-identifier=<siteId>` + `site-id=<siteId>` で実現**(Alert と違い siteName フィルタは不要)。
- オプション: `search` / `filter`(OData v4、`eq`/`in`/`and` のみ、フィールドは eventId/category/sourceType)/ `sort`(timeAt asc|desc)/ `next`(ページング、≥1)。

### レスポンス形式

```jsonc
{
  "events": [
    {
      "eventId": "10017",
      "eventIdentifier": "38b0fa4f-…",     // 一意 ID
      "timeAt": "2026-07-24T00:04:50.384Z", // ISO(そのまま使える)
      "severity": "negative",               // negative | neutral | positive
      "eventName": "Client Onboarding Failure - Authentication/Association",
      "category": "Clients",                // Clients / Wifi Key Management / …
      "sourceType": "Wireless Client",
      "sourceName": "iPad",                 // ※末尾に NUL(\0)パディングが載ることがある → 要 strip
      "reason": "Capability requested by client unsupported by AP",
      "description": "Onboarding failed for client … to BSSID …",
      "clientMacAddress": "11:22:33:44:55:66",
      "deviceMacAddress": "aa:bb:cc:dd:ee:ff",
      "serialNumber": "…",
      "bssid": "aa:bb:cc:dd:ee:ff",
      "stackId": null
    }
  ],
  "next": 2, "count": 50, "total": 7425
}
```

- `total` はサイト単位でも数千件規模(Home で過去 24h に total≈7425)。**onboarding failure 等の高頻度イベントが多い**。
  詳細パネルでは `limit=50` で先頭のみ表示する(母集団の総数は `total` として注記)。
- `sourceName` に **NUL バイト(`\0`)パディング**が入ることがある。表示前に `replace(/\0/g,"").trim()` で除去する。
- severity は 3 値: `negative`(問題)/ `neutral`(情報)/ `positive`(復旧・成功)。UI では警告/情報/正常のチップに割り当てる。

### 11 番詳細パネルへの反映

- `central-client.ts` の `getSiteDetail()` で events を **`network-troubleshooting/v1/events`(context-type=SITE)** から取得するよう変更。
  Central 1 サイトあたりの HTTP は **4 本 → 5 本**(health/clients/devices/alerts/**events**)。Mist と同数になった。
- 詳細型 `DetailEvent` に `severity` / `category` を追加(Central は値あり、Mist は null)。
- View の Event セクションは、旧「取得不可」注記に代えて **実イベントを severity チップ + カテゴリ付き**で表示。

---

## Task 2: 接続クライアント一覧の拡充 → 既に一覧化済み。スクロール枠を追加

11 番の時点で詳細パネルのクライアントセクションは既に**件数だけでなく個々のクライアントの表**
(クライアント名/ベンダー・OS・SSID・帯域/CH・SNR/RSSI・IP・接続先)を表示していた(11_findings 4-2)。
本タスクでは以下を追加した:

- クライアント表を **独立スクロール枠(sticky ヘッダ + max-height)** に入れ、クライアント数が多いサイトでも
  ヘッダを固定したままスクロールできるようにした(`.go-dp-scroll`)。
- Central/Mist で取れる項目差は 11 番どおり(Central は RSSI を返さないため「—」)。欠損は `—` 表示のまま。

### 実データ確認(コンテナ経由)

| サイト | クライアント数 | 主な表示 |
|---|---|---|
| Central `Home` | (実データ) | 名前/ベンダー・OS・SSID・帯域(2.4/5/6GHz)・CH・SNR・IP・接続先 AP |
| Mist `<SITE_A>` | 7 | 上記 + RSSI。band は "24"→"2.4 GHz" 正規化 |

---

## Task 3: クライアント詳細情報 → **実装した(オンデマンド・1 クライアント 1 呼び出し)**

### 判断根拠(実測)

クライアント 1 件の詳細に必要な追加 API 呼び出しは **各プラットフォーム 1 本のみ**で、
タスクの許容基準(「1 クライアントあたり 1 回程度ならオンデマンドで許容」)を満たす:

| プラットフォーム | エンドポイント | 呼び出し数 | 返る主な情報 |
|---|---|---|---|
| Central | `network-troubleshooting/v1/events?context-type=WIRELESS_CLIENT&context-identifier=<mac>&site-id=<siteId>&start-at&end-at` | **1** | そのクライアントの Onboarding/認証等イベント履歴(timeAt/severity/eventName/reason) |
| Mist | `api/v1/sites/{siteId}/clients/events/search?mac=<mac>&start&end` | **1** | ローミング/接続品質イベント(type/rssi/channel/band/ssid/ap/text、例 CLIENT_GW_ARP_OK) |

- 実装は 11 番のサイト詳細と同じオンデマンド方式。**行クリック時のみ**発火し、定期ポーリングには含めない。
- 30 秒キャッシュ + in-flight 共有(サイト詳細と同じガード)を `client-detail` にも適用。
- UI は**クライアント表の行を展開(アコーディオン)**して、その下にイベント履歴を差し込む形にし、
  新しい全画面パネルを増やさず 11 番と同程度の複雑さに収めた。

---

## Task 4: ポーリング間隔のデフォルト変更(3→5 分)と設定可能化 → 実装

- **既定を 3 分(180000ms)→ 5 分(300000ms)** に変更(`poller.ts` の既定 / `docker-compose.yml` の既定 / `.env`)。
- Global Overview 画面フッターに **間隔選択のプルダウン**(1 / 3 / 5 / 10 / 15 分)を追加。
- 変更は `POST /api/global-overview/settings` でサーバに保存 → `poller.ts` が **setInterval を張り直して即反映**。
- **下限 60 秒(1 分未満は選択不可)**・上限 60 分でクランプ(レート制限を圧迫しない範囲)。
- 設定値は **`data/global-overview/settings.json` に永続化**。`./data` はホストへの bind mount なので
  **`docker compose up -d --build` / `--force-recreate` 後も保持**される。
- 起動時は settings.json を読み、無ければ env 既定(5 分)を使う(settings.json が env より優先)。

---

## 動作確認結果(`docker compose up -d --build` 後・実データ)

コンテナ再ビルド後 `/health` = `{"ok":true,…,"mcpConfig":{"source":"live"}}`。起動ログ
「ポーリング開始: 300s 間隔」。`/status` = `pollIntervalMs=300000 / central throttled=0 / mist throttled=0 /
central.ok=true / mist.ok=true`。

### Task 1(Central Event)

| 確認項目 | 結果 |
|---|---|
| Central `Home` site-detail の events | **status=ok / 50 件 /「直近 24h・全 7616 件中 50 件」** |
| Central 1 サイトあたり HTTP(定常) | **5 本**(health/clients/devices/alerts/**events**。トークンキャッシュ後) |
| severity | `negative` / `neutral` / `positive` の 3 値を確認 |
| sourceName の NUL パディング | `cleanStr` で除去され「iPad」等に正規化 |
| UI(詳細パネル) | 旧「取得不可」注記に代わり実イベントを severity チップ(赤=negative/灰=neutral/緑=positive)+ category「Clients」+ デバイス名 + 時刻で表示(ブラウザ実機で確認) |

### Task 2(クライアント一覧)

- Central `Home`: 12 クライアントを sticky ヘッダ + 縦スクロール枠の表で表示(名前/ベンダー・OS・SSID・帯域(5 GHz 等)・SNR・IP・接続先 AP)。
- Mist `<SITE_A>`: 7 クライアント。RSSI も表示、band は "2.4 GHz" 等に正規化。ブラウザ実機で確認。

### Task 3(クライアント詳細・実装)

| 確認項目 | 結果 |
|---|---|
| Central client-detail(mac 指定) | **status=ok / 30 件 / requests=1** |
| Mist client-detail(mac 指定) | **status=ok / 25 件 / requests=1** |
| UI | クライアント行クリックで直下にイベント履歴をインライン展開(Amazon FireTV で DHCP Ack/Onboarding Success を確認)。追加 HTTP は 1 本、30 秒キャッシュ + in-flight 共有つき。ブラウザ実機で確認 |

### Task 4(ポーリング間隔)

| 確認項目 | 結果 |
|---|---|
| 既定 | 起動ログ「300s 間隔」(= 5 分)。フッターのプルダウンも「5 分」 |
| GET /settings | `{pollIntervalMs:300000, optionsMs:[60000,180000,300000,600000,900000], minMs:60000, maxMs:3600000}` |
| POST /settings 600000 | 適用 + タイマー張り直し(ログ「600s 間隔」)|
| 下限クランプ | 5000ms 指定 → **60000ms**(1 分)に丸め |
| 永続化 | `data/global-overview/settings.json` に保存。**900000 に設定 → `docker compose up -d --build`(コンテナ再作成)後の起動ログ「settings.json から復元: 900s」で保持を確認**(settings.json が env 既定 300s を上書き)|
| UI | フッターのプルダウン(1/3/5/10/15 分)で変更 → サーバ保存 + 即反映。ブラウザ実機で確認 |

> 最終状態は既定の 5 分(`settings.json = {"pollIntervalMs":300000}`)に戻してある。

## 変更・追加ファイル一覧

```
plugins/global-overview/detail-types.ts       DetailEvent に severity/category 追加、ClientDetail(Envelope) 追加
plugins/global-overview/central-client.ts     fetchCentralEvents/fetchCentralClientEvents 追加、getSiteDetail に events 組込(4→5本)、cleanStr
plugins/global-overview/mist-client.ts        fetchMistEvents に severity/category、fetchMistClientEvents 追加
plugins/global-overview/site-detail.ts        getClientDetail 追加(30s キャッシュ + in-flight 共有)
plugins/global-overview/poller.ts             ポーリング間隔を可変化・settings.json 永続化・setPollInterval/loadSettings/getSettings、既定 5 分
plugins/global-overview/api.ts                /client-detail・/settings(GET/POST)追加、getPollIntervalMs へ差し替え、loadSettings 呼出
plugins/global-overview/view/detailTypes.ts   サーバ型のミラー(DetailEvent・ClientDetailEnvelope)
plugins/global-overview/view/api.ts           fetchClientDetail・fetchSettings・updatePollInterval 追加
plugins/global-overview/view/SiteDetailPanel.tsx  クライアント行の展開(Task3)・EventList(severity チップ)・スクロール枠
plugins/global-overview/view/GlobalOverview.tsx   ポーリング間隔プルダウン(Task4)
plugins/global-overview/view/styles.css       .go-dp-scroll / 展開行 / evsev チップ / interval-select
docker-compose.yml / .env / .env.example      GLOBAL_OVERVIEW_POLL_MS 既定 180000→300000
```

`npm run typecheck`(tsc --noEmit)/ `vite build` 通過。git 操作は行っていない。
