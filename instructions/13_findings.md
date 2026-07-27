# 13_findings — 詳細パネルの全画面化 / Event・Alert 独立画面 / Webhook 実現性

対象タスク: `instructions/13_panel_layout_events_webhook.md`
調査・実装日: 2026-07-24
実装先: `plugins/global-overview/`(バックエンド + View)、`src/main.tsx`

> 認証情報の値そのものは記載しない。REST の実測は git 管理外の `.env` の資格情報で行った。
> テナント規模: **Central 13 サイト / Mist 9 サイト = 計 22 サイト**(スナップショット実測)。

---

## Task 1: サイト/クライアント詳細の表示拡大 → **全画面表示に変更(採用)**

### 比較検討と判断

| 案 | 長所 | 短所 | 判断 |
|---|---|---|---|
| A. サイドパネルの幅を広げる(例 560px → 900px) | 変更が CSS 1 行。一覧を見ながら詳細を読める | 7 列のクライアント表は 900px でも窮屈。イベント 50 件は結局縦スクロール。広げるほど「背後の一覧」が見えず、オーバーレイである意味が薄れる | 見送り |
| **B. 全画面表示(一覧と入れ替え)** | 横幅を全部使える。2 カラムに置けるので縦スクロールが激減。Health / デバイス / アラート / イベントを同時に視認できる | 一覧が同時に見えない。「戻る」導線が必要 | **採用** |

情報量の実測(このテナント):デバイス最大 9 台、クライアント最大 13 件 × 7 列、イベント最大 50 件、
Mist の Health は SLE 7 指標。**560px 幅のパネルに縦積みでは、クライアント表が横に潰れ、
イベントに到達するまで長いスクロールが必要**だった。横幅を使える B の利得が明確に大きい。

### 実装方式(ルーティングライブラリは追加していない)

タスクの指定どおり、既存のタブ切替(`main.tsx` のローカル state 方式)と同じ考え方で実装した。

- `GlobalOverview.tsx` の `detailTarget` state が立っているあいだ、**一覧側を `hidden` で隠し**、
  代わりに `SiteDetailPage` を描画する(`plugins/global-overview/view/SiteDetailPage.tsx`。
  11 番の `SiteDetailPanel.tsx` をリネームしたもの)。
- **条件レンダリングではなく `hidden`** にしたのは、一覧を unmount すると Leaflet 地図が作り直され、
  ズーム位置・スナップショットの表示状態が飛ぶため(`main.tsx` のタブと同じ理由)。
  `.go-root[hidden] { display: none }` を追加(`[hidden]` の UA 既定は `.go-root` の `display:flex` に負ける)。
- 戻る導線: ヘッダ左の **「← 一覧に戻る」ボタン** と **Esc キー**(11 番のパネル時代と同じキー操作を維持)。
- 地図ピンから開いた場合もテーブル行から開いた場合も `onPick()` を通るので、**同じ全画面ページ**に入る。

### レイアウト

```
[← 一覧に戻る] ● サイト名  Mist · 正常 · デバイス 7/7 · クライアント 10 · アラート 0     取得 … · HTTP 5 本
┌────────────────────────┬────────────────────────┐
│ Health / SLE           │ デバイス               │   ← 2 カラム
├────────────────────────┴────────────────────────┤
│ 接続クライアント(7 列。全幅)                  │   ← .go-sd-wide で全幅
├────────────────────────┬────────────────────────┤
│ アラート               │ イベント               │   ← 各カード内で 460px スクロール
└────────────────────────┴────────────────────────┘
```

- 1100px 未満では 1 カラムに畳む(`@media (max-width: 1100px)`)。
- アラート / イベントは左右に並ぶため、片方が長くてももう片方が引きずられないよう
  **カード内スクロール(max-height 460px)**にした。クライアント行を展開したときの入れ子の
  イベント一覧には効かせない(`.go-sd-card > .go-dp-sec > .go-dp-list` と直下だけを対象にしている)。

### 副次的に見つかった不具合と修正(SiteMap)

全画面化に伴い「テーブル行クリック = 詳細ページへ遷移」になったため、**地図が `display:none` の状態で
`marker.openPopup()` が走る**ようになり、一覧に戻ったときポップアップが幅 0 で組まれて縦長に潰れていた。
→ `SiteMap.tsx` のフォーカス effect に `active` を追加し、**非表示中は開かず、表示に戻った時点で開き直す**
(`invalidateSize` の 60ms を待つため 90ms 遅らせる)ようにした。ブラウザ実機で修正を確認済み。

---

## Task 2: Event / Alert 独立画面 → **org 単位取得が可能と判明。実装した**

### 調査 1: org(テナント)単位で全サイト分を一括取得できる API はあるか

実測(curl)結果:

| プラットフォーム | 種別 | エンドポイント | org 一括 | 結果 |
|---|---|---|---|---|
| Central | アラート | `GET network-notifications/v1/alerts` | **可** | そもそも siteName / siteId で filter **できない**(=常に org 全体)。`items[].siteName` でサイトを判別する。**1 リクエストで全 22 サイト分** |
| Central | イベント | `GET network-troubleshooting/v1/events` | **不可** | `site-id` が必須。`context-type` に org 相当の値が無い |
| Mist | アラーム | `GET /api/v1/orgs/{org}/alarms/search` | **可** | 結果に `site_id` あり |
| Mist | デバイスイベント | `GET /api/v1/orgs/{org}/devices/events/search` | **可** | 結果に `site_id` あり |
| Mist | クライアントイベント | `GET /api/v1/orgs/{org}/clients/events/search` | **可** | 結果に `site_id` あり |

Central のイベントで org 一括ができないことの根拠(実測ログ):

```
context-type=ORGANIZATION → 400 HPE_GL_NETWORK_EVENTS_INVALID_INPUT
   "Invalid value supplied for 'context.contextType': organization"
context-type=GLOBAL       → 200 だが total=0(context-identifier に何を入れても 0 件。site-id も依然必須)
site-id を外す            → 400 HPE_GL_NETWORKING_ERROR_BAD_REQUEST(context-type/identifier の有無に関わらず)
```

つまり **Central のイベントだけがサイト単位ループ**になる。他の 4 系統は org 一括。

### 調査 2: 呼び出しコスト(実測)

`GET /api/global-overview/events` を実装して実測した(コンテナ内・24 時間窓):

| 取得元 | HTTP 本数 | 件数 | 備考 |
|---|---|---|---|
| Central アラート | 1(+ トークン取得 1) | 25 | limit=100 が上限。全 status(Active 2 / Cleared 23) |
| Central イベント | **13**(= Central サイト数) | 154 | 各サイト最大 30 件 |
| Mist アラーム | 1 | 5 | |
| Mist デバイスイベント | 1 | 200 / 全 218 | |
| Mist クライアントイベント | 1 | 200 / 全 4,602 | 24h で 4,600 件出るため上限で絞る |
| **合計** | **18 本** | **584 件** | JSON **約 272 KB** |

所要時間: **約 4.7 秒**(Central と Mist を並行実行 + Central の 13 本を Promise.all でレートリミッタに任せた場合)。
直列に await した初版は 13.4 秒だったので、**並行化で 1/3 に短縮**している。
レート枠: Central は `X-RateLimit-Limit: 10`(1 秒あたり・アカウント共有)に対し自主規制 4 req/sec。
18 本は 1 回の取得で数秒に分散されるので枠を圧迫しない。

### 判断: **定期ポーリングには入れず、オンデマンド専用として独立画面を実装**

- **実装する理由**: org 一括が 4 系統で使え、Central のループも 13 本で済む。
  「22 サイト全部をループするしかない」状況ではなく、コストは十分現実的だった。
- **定期ポーリングに入れない理由**:
  - 現行ポーリングは 1 巡 6 本(Central 3 + Mist 3)。これに 18 本を足すと **1 巡 24 本 = 4 倍**になる。
    5 分間隔なら 1 時間あたり 72 本 → 288 本。枠には収まるが、**見ていない画面のために毎回 4 倍払う**ことになる。
  - イベントは「見たいときに直近を見る」種類の情報で、履歴を貯める要件は今回の範囲に無い。
- **代わりのガード**: サーバ側で **60 秒キャッシュ + in-flight 共有**(`events-feed.ts`)。
  画面を開いた初回だけ自動取得し、以降は「更新」ボタン(`?force=1`)でのみ再取得する。
  キャッシュヒット時は 80ms で応答し、外部 API を一切叩かない(実測)。

### 実装した画面(タブ「Event / Alert」)

`src/main.tsx` に 3 枚目のタブとして追加。`plugins/global-overview/view/EventFeed.tsx`。

- **取得元カード**: 5 系統それぞれの成否・件数・「全 N 件中 M 件」・HTTP 本数を出す。
  1 系統だけ落ちても他は表示する(Central のイベントは「13/13 サイト」のように成功サイト数を出す)。
- **フィルタ**: **サイト名 / 重要度 / カテゴリ**(タスク指定)+ 種別(アラート/イベント)・
  プラットフォーム・本文フリーテキスト。「クリア」で全解除。
- **タイムライン**: 新しい順。初期 300 件表示 + 「さらに表示」。
- **重要度の正規化**: API ごとに語彙が違う(Central アラート `Critical/Major/Info`、
  Central イベント `negative/neutral/positive`、Mist アラーム `critical/warn/info`、
  **Mist のイベントは重要度を持たない**)。サーバ側で **重大 / 警告 / 情報** の 3 段階に正規化し、
  生の値は `severityRaw` に残して行の tooltip に出す。重要度を持たない取得元は
  「情報」の右に `*` を付け、`*` の tooltip で「この API は重要度を返しません」と明示する
  (0 件と欠損を混同しないという既存方針の踏襲)。
- **サイト名の解決**: Mist は `site_id` しか返さないため、**ポーラーのキャッシュ済みスナップショット**の
  `sites[]` で名前に解決する(追加 API は出さない)。

---

## Task 3: Webhook ベースのイベント取得 → **現構成では非現実的。実装しない(コード変更なし)**

### 調査 1: Webhook 機能の有無

| プラットフォーム | Webhook | 実測・出典 |
|---|---|---|
| **Juniper Mist** | **あり** | `GET /api/v1/orgs/{org}/webhooks` → **200 `[]`**(機能は有効・現在 0 件登録)。`GET /api/v1/const/webhook_topics` で購読可能トピックを取得でき、`alarms` / `device-events` / `device-updowns` / `client-join` / `client-sessions` / `audits` などが `for_org: true`(org 単位で登録可) |
| **HPE Aruba Networking Central(New Central)** | **あり(ただし UI 設定)** | ドキュメント上、Alert Management カードから Webhook を有効化でき、アラートは JSON を HTTP POST で送出。**REST の webhook 管理エンドポイントは今回のベース URL では見つからなかった**(`network-notifications/v1/webhooks` / `notifications/v1/webhooks` / `central/v1/webhooks` / `…/subscriptions` はいずれも **404 Route Not Found**) |

### 調査 2: 着信を受けるために必要なもの(現構成でのハードル)

本アプリは **MacBook 上の Docker(`multi-network-dashboard` :8092)** で動いており、
外部から到達できるのは「MacBook のローカルホストからコンテナへ」の内向きだけ。
Central / Mist のクラウドから POST を受けるには、以下がすべて必要になる。

| 必要なもの | 現状 | ハードル |
|---|---|---|
| インターネットから到達可能なグローバル IP / FQDN | 無い(家庭内 NAT 配下) | ISP 契約変更 or トンネル導入が必要 |
| ポート開放(443)+ ルータの静的 NAT | 無い | 家庭内ルータの設定変更。ノート PC の持ち出し・スリープで簡単に切れる |
| 有効な HTTPS 証明書 | 無い(HTTP :8092) | Let's Encrypt 等 + 独自ドメイン。自己署名は送信側に拒否されうる |
| 常時稼働 | 無い(MacBook はスリープ/移動する) | Webhook は**再送保証が弱い**ため、落ちている間のイベントは欠落する |
| 受信の認証・検証 | 未実装 | Mist は secret による署名検証を持つ。誰でも POST できる口を開けることになるため必須 |
| 代替のトンネル(ngrok / Cloudflare Tunnel 等) | 未導入 | 常設には有料プラン(固定 URL)が要る。無料版は URL が起動ごとに変わり、その都度 Central/Mist 側の登録を書き換える必要がある |

**結論: 現在のローカル Docker 構成のままでは実現性が低い。** ハードルは技術的というより
「常時稼働する公開エンドポイントを用意する」という運用要件で、ノート PC 上のダッシュボードとは相性が悪い。

### 調査 3: 代替案

1. **【推奨】Task 2 の Event / Alert 独立画面で代替する(実装済み)**
   全サイト横断のタイムラインを 18 本 / 約 5 秒で取得でき、Webhook で得たい「今なにが起きているか」は
   ほぼ満たせる。取得のトリガーはユーザーの操作なので、常時稼働も公開 IP も要らない。

2. **ポーリング間隔の短縮**(既存機能。フッタのプルダウンで 1 分まで短縮可)
   1 分間隔にするとポーリングは 1 巡 6 本 → 1 時間 360 本。Central の枠(10 req/sec)には収まるが、
   同じ資格情報を使う `central-mcp-http` と取り合いになるため、常用は 5 分のままを推奨。

3. **【将来やるなら本命】WebSocket ストリーミング API(アウトバウンド接続)**
   Webhook と違い **こちらから張りに行く**接続なので、**グローバル IP もポート開放も証明書も不要**。
   NAT 配下の MacBook でもそのまま使える。
   - Mist: `wss://api-ws.mist.com/api-ws/v1/stream` に接続してチャネルを購読する
     (device-events / alarms 等。チャネルは site_id 指定)。認証は既存の API トークンを流用できる。
   - New Central: Streaming API(WSS)。認証は **今使っているのと同じ OAuth2 アクセストークン**で、
     追加の資格情報は不要。ただしペイロードは **CloudEvents + Google protobuf** で、
     封筒と本体の 2 段デコードが必要。トークンの寿命(約 2 時間)が切れると切断されるため、
     再取得と再接続のロジックが要る。
   - コスト: protobuf スキーマの取り込みと、常時接続の管理(再接続・バックオフ・重複排除)が必要で、
     Task 2 の実装よりは重い。**「準リアルタイムが本当に要る」と分かってから着手すべき**と判断する。

出典(Task 3 のドキュメント確認分):
[Alert Notifications with Webhooks (New Central)](https://developer.arubanetworks.com/new-central/docs/alert-with-webhooks) /
[Getting Started with Streaming APIs (New Central)](https://developer.arubanetworks.com/new-central/docs/streaming-api-getting-started) /
[Setting up Webhooks in Mist](https://www.mist.com/documentation/webhooks/) /
[WebSocket API Overview (Juniper Mist)](https://www.juniper.net/documentation/us/en/software/mist/automation-integration/topics/concept/websocket-api-overview.html)

---

## 変更・追加ファイル一覧

```
plugins/global-overview/feed-types.ts             新規。FeedItem / FeedSource / FeedEnvelope
plugins/global-overview/events-feed.ts            新規。org 一括 + Central サイトループの取りまとめ、60s キャッシュ
plugins/global-overview/central-client.ts         fetchAllAlerts / fetchSiteEvents / getRequestCount 追加
plugins/global-overview/mist-client.ts            fetchOrgAlarms / fetchOrgDeviceEvents / fetchOrgClientEvents / getRequestCount 追加、OrgAlarm・OrgEvent 型
plugins/global-overview/api.ts                    GET /events(?force=1)追加
plugins/global-overview/view/feedTypes.ts         新規。サーバ型のミラー
plugins/global-overview/view/EventFeed.tsx        新規。Event / Alert 独立画面(フィルタ + タイムライン)
plugins/global-overview/view/api.ts               fetchEventFeed 追加
plugins/global-overview/view/SiteDetailPage.tsx   SiteDetailPanel.tsx をリネーム。全画面ページ化(2 カラム + 戻る導線)
plugins/global-overview/view/GlobalOverview.tsx   詳細を開いているあいだ一覧を hidden に。SiteMap の active を連動
plugins/global-overview/view/SiteMap.tsx          非表示中に openPopup しない修正(表示復帰時に開き直す)
plugins/global-overview/view/styles.css           .go-sd-*(全画面ページ)/ .go-src-*・.go-f*(Event 画面)追加
src/main.tsx                                      タブ "Event / Alert" を追加(3 枚構成)
```

`npx tsc --noEmit` / `npx vite build` 通過。`docker compose up -d --build` で再ビルドし、
ブラウザ実機で確認した(ライト = 1512px で全画面詳細・Event 画面、ダーク = 1512px と 1000px で同 2 画面)。
コンソールエラーなし。git 操作は行っていない。Task 3 はコード変更なし(調査のみ)。
