# 17_findings — Webhook ログタブ / 自動事前調査 / 関連情報の先読み

対象タスク: `instructions/17_webhook_feed_tab.md`
実装・検証日: 2026-07-26
実装先: `plugins/webhook-feed/`(新規)、`plugins/network-investigation/`(source="auto" の追加)、`src/main.tsx`

> 認証情報の値そのものは記載しない。サービスアカウント鍵は `secrets/`(`.gitignore` 済み)にあり、
> リポジトリにも Docker イメージにも入れていない(`.dockerignore` に `secrets` を追加、
> docker-compose が read-only でバインドマウントする)。

---

## Task 1: Google Sheets 読み取り基盤

### 認証

`googleapis` v173 を導入し、サービスアカウント JSON 鍵で `spreadsheets.readonly` のみを要求する。
鍵のパス解決は 3 段(`plugins/webhook-feed/sheets-client.ts` の `resolveKeyFile`):

1. `WEBHOOK_LOG_SA_KEY_FILE`(明示指定)
2. `secrets/sheets-service-account.json`(タスクが想定するパス)
3. `secrets/` 直下の `*.json`

3 を入れたのは、Google Cloud が配布する鍵のファイル名が `<project>-<keyid>.json` 固定で、
実環境ではリネームせず置かれていたため。リネームを強制せずそのまま動くようにした。

**Drive API は使えなかった**: スプレッドシートを自動検出しようと `drive.files.list` を試したが
`Google Drive API has not been used in project ... or it is disabled`。
Sheets API だけが有効化されていたため、スプレッドシート ID は `.env` の
`WEBHOOK_LOG_SPREADSHEET_ID` で受け取る方式にした(未設定なら画面に理由が出るだけで、他機能は落ちない)。

### 値の読み方 — `UNFORMATTED_VALUE` を選んだ理由

`valueRenderOption` の 2 択はどちらも欠点があり、実測して選んだ:

| 方式 | 17 桁の New Central サイト ID(実体 `84948618233618432`) | 日時 |
|---|---|---|
| `FORMATTED_VALUE` | `"8.49486E+16"` ← **表示丸めで桁が消える** | `"2026-07-26 10:40:30"`(そのまま使える) |
| **`UNFORMATTED_VALUE`(採用)** | `<SITE_ID>` ← 末尾 2 桁ずれるが桁数は保つ | `46229.44479166667`(シリアル値。自前で変換) |

`UNFORMATTED_VALUE` を採用し、日時はスプレッドシートの `properties.timeZone`(実測 `Asia/Tokyo`)で
ISO へ変換する(`serialToIso` / `cellToIso`)。変換の検証: シリアル `46229.44479166667` →
`2026-07-26T01:40:30.000Z` = JST 10:40:30 で、`FORMATTED_VALUE` の表示と一致した。

**根本原因は Apps Script 側にある**: 17 桁のサイト ID をシートへ「数値」として書いているため、
セルの時点で IEEE754 倍精度の限界(2^53)を超えて丸まっている。`...432` が `...430` になっており、
**この欠落はシート側で既に起きているのでアプリ側では復元できない**。
アプリ側は「相対誤差 1e-12 以内なら同一サイト」とみなす救済(`enrich.ts` の `siteIdMatches`)で対処した
(桁数の違うサイト ID がこの閾値で衝突することはない)。
恒久対策としては、**Apps Script 側で Site ID を文字列として書き込む**(先頭に `'` を付ける等)のが望ましい。

### 差分検知

`data/webhook-feed/state.json` にシートごとの `lastRow` を持ち、次回は `A{lastRow+1}:Z` だけ読む。
3 シートぶんを **`values.batchGet` 1 本(HTTP 1 本)** にまとめている。
同じ batchGet に「前回の最終行がまだ存在するか」を確かめるアンカー範囲(`A{lastRow}:A{lastRow}`)も入れ、
消えていればそのシートだけ全件読み直す(シートのクリア・縮小への対応)。

---

## Task 2: バックエンド API・ポーリング

| エンドポイント | 内容 |
|---|---|
| `GET /api/webhook-feed/snapshot` | キャッシュ済みの統合フィード。Sheets は叩かない |
| `POST /api/webhook-feed/refresh` | 手動更新(最短間隔 30 秒でガード) |
| `GET/POST /api/webhook-feed/settings` | **この画面専用**のポーリング間隔(既定 300000ms) |
| `GET /api/webhook-feed/status` | 資格情報の設定状況・シートごとの読み取り位置(鍵の中身は出さない) |

Global Overview の `poller.ts` と同じ骨格(settings.json 永続化 / in-flight 共有 / 最短間隔ガード /
スナップショットのファイル書き出し)。**設定ファイルは別**(`data/webhook-feed/settings.json`)。

新規行が無ければ Sheets は空配列を返すので、キャッシュをそのまま使い回す。
既定 5 分 × HTTP 1 本 = 0.2 req/min。Sheets の読み取り枠(300 req/min/プロジェクト)に対して 0.07%。

### 統合スキーマへの変換(`mapping.ts` 1 箇所に集約)

実測した列構成(2026-07-26 時点):

| シート | 列 | 一意 ID に使った列 | サイト |
|---|---|---|---|
| `CentralLog`(New Central・20 列) | Severity / Site ID / Alert ID … | **Alert ID**(Active→Cleared で同値) | Site ID あり |
| `ClassicCentralLog`(Classic・14 列) | Severity / Device ID / NID … | **列 C**(ES のドキュメント ID) | **なし** |
| `MistLog`(Mist・11 列) | Severity / Site ID / Topic … | Raw JSON の `id`、無ければ `topic+MAC+type+ts` | Site ID あり |

シート側の落とし穴を 2 つ確認した:

1. **`ClassicCentralLog` の B 列と C 列のヘッダが両方 `Alert Time (JST)`**。実際の C 列は
   ES のドキュメント ID(`AZ-cJEImKOWhHlup7pE2` 等)。ヘッダ名では解決できないので、
   この 2 列だけ添字で固定した(他の列はヘッダ名で解決するので列が増減しても壊れない)。
2. **`NID` は行の一意 ID ではなくアラート種別の番号**(1252 = `AP_RADIO_OVER_UTILIZATION` など)。
   重複防止キーに使うと別事象まで潰れるため使っていない。

重要度は Global Overview の `events-feed.ts` と同じ 3 段階へ正規化し、
「そもそも重要度列が空」(Mist の `client-info` / `device-events` など)を表す `unknown` を足した。

---

## Task 3: 「Webhook ログ」タブ

タブは 4 枚構成になった(Global Overview / Event / Alert / **Webhook ログ** / ネットワーク調査)。
骨格・クラス名は `EventFeed.tsx` を踏襲し、この画面固有のものだけ `wf-*` を足している。

- ソース別バッジ(New Central = オレンジ / Classic = アンバー / Mist = グリーン)
- 重要度で色分け・ソース / 重要度 / サイト / カテゴリ / 全文検索 / 「自動調査ありのみ」でフィルタ
- 行を展開すると「AI による自動事前調査」「関連情報(サイト状況)」「生データ(列名 → 値)」
- 各行の「調査する」→ 15 番の共有 state(`pendingInvestigationQuery`)でネットワーク調査タブへ
- フッタにこの画面専用の間隔プルダウン(1/3/5/10/15/30 分)。
  ラベルは **「Webhook ログの自動更新間隔」** とし、
  「この設定は Webhook ログの取得のみ / Global Overview のポーリング間隔とは別設定です」を併記した。

「調査する」は自動事前調査済みの行だけ文面が変わる(`buildFollowUpQuery`)。
既に出ている要約を本文に添えて「重複する説明は省き、まだ分かっていない点を掘り下げて」と依頼する形にした。

---

## Task 4 / Task 5: 自動事前調査と関連情報の先読み

発火条件が同じなので、指示どおり 1 つのトリガー処理(`enrich.ts` の `trigger()`)にまとめた。

### 発火条件(コストとレート制限の両方を絞る)

1. **重要度が最上位(`severity === "Critical"`)の行だけ**。Major / warn は対象外。
   Task 5 のレート配慮(Central 4 req/sec)もこの絞り込みで満たしている。
2. **同一アラート(`alertKey`)は一生に 1 度だけ**。`state.json` に永続化する。
3. 受信から `WEBHOOK_FEED_AUTO_MAX_AGE_MS`(既定 60 分)を超えた行は発火しない。
   ポーリングが止まっていた間に溜まった古いアラートで一気に課金されるのを防ぐ。
4. 1 巡あたり `WEBHOOK_FEED_AUTO_MAX_PER_CYCLE` 件(既定 3)まで。
5. **初回バックフィル(`state.json` が無い回)では一切発火しない**。
   実測 411 行の過去ログを初めて読むので、ここで発火させると Insight Agent が数十本走る。
   その時点の重大アラートは「発火済み」として記録だけしておく。
6. Insight Agent は直列キューで 1 本ずつ。

### タイムラインとの連携

`runQuery` に `source: "auto"` を追加し(`plugins/network-investigation/api.ts` の
`runAutoInvestigation`)、対話・定期実行とまったく同じ経路を通す。
その結果、SSE の見える化も `query-history.jsonl` への追記も同じように行われ、
タイムラインでは **アンバーの「自動調査」タグ**(手動 / 定期と別色)で表示される。

### 実装中に見つけて直した 2 点

1. **`atomicWrite` の競合**: 自動調査の `markDone` が複数件同時に走ると、同じ `state.json.tmp` に
   2 本が書き、先に rename した側が tmp を消すため後発が `ENOENT` で落ちていた(実測でログに出た)。
   ファイルごとに書き込みを直列化するチェーンを入れて解消。
2. **調査結果が `feed.json` にしか無かった**: フィードのキャッシュを作り直すと結果が消えた。
   `state.json` の `autoInvestigated[alertKey]` に調査結果と先読み結果ごと持たせ、
   行のマッピング時に再アタッチする方式に変更した。副次的な利点として、
   **1 アラートが複数行になるソース(New Central の Active / Cleared)では全行に同じ結果が出る**。

---

## 動作確認(実データ)

### Task 6-1: Sheets の読み取り

```
[webhook-feed] Google Sheets 認証: keyFile=secrets/<鍵>.json account=<サービスアカウント>
[webhook-feed] refresh 完了: 新規 411 行 / 保持 411 件
               (New Central=9 Classic Central=13 Mist=389) HTTP 1 本
```

スプレッドシート `webhook-log` / タイムゾーン `Asia/Tokyo` を取得。
サイト解決 395 / 397 件(残り 2 件はシート上のテスト行 `site-001` / `test-site-id`)。
17 桁の `<SITE_ID>` は許容誤差マッチで `<SITE_D>` に解決できた。

### Task 6-4: 自動事前調査と重複防止

| 回 | 読み込み | 発火 | 結果 |
|---|---|---|---|
| 1 回目 | CentralLog を巻き戻して 9 行を「新規」として再読 | 1 件 | `114c6324…`(<SITE_E> / Switch Offline)→ runId `c4b4d998…` |
| 2 回目 | 同じ 9 行を再度「新規」として再読 | 1 件 | **`114c6324…` は再実行されず**、次のアラート `ab1046ae…`(<SITE_D>)が発火 |

- `114c6324…` は Active / Cleared の **4 行**に現れるが、自動調査は **1 回だけ**(runId は 2 回目も同じ)。
- `query-history.jsonl` の内訳は `{ manual: 42, scheduled: 6, auto: 2 }`。
- 先読み(Task 5)も同時に発火: <SITE_E> は `health=0 / devices=0/1 / alerts=0 /
  Poor 100% Fair 0% Good 0% / アラートの母集団 = status = Active(未解消)` を取得できた。
- Classic Central の行は `siteContext.status = "unavailable"`(理由文つき)になる。Webhook にサイト ID が無いため。

> 検証では発火条件を確実に満たすため `WEBHOOK_FEED_AUTO_MAX_AGE_MS` を一時的に 4 時間へ、
> `WEBHOOK_FEED_AUTO_MAX_PER_CYCLE` を 1 にして実行した。既定値(60 分 / 3 件)は変えていない。

### Task 6-3: ポーリング間隔の独立性

```
変更前  global-overview=300000  webhook-feed=300000
webhook-feed を 600000 に変更
変更後  global-overview=300000  webhook-feed=600000     ← Global Overview は不変
ファイル data/global-overview/settings.json = {"pollIntervalMs":300000}
         data/webhook-feed/settings.json    = {"pollIntervalMs":600000}
コンテナ再起動後  global-overview=300000  webhook-feed=600000  ← 両方とも永続化されている
```

確認後 webhook-feed は 300000(5 分)に戻した。

### Task 6-5: `docker compose up -d --build`

`/health` = `{"ok":true,...,"mcpConfig":{"source":"live",...}}`。
`GET /api/webhook-feed/status` で `configured:true` / `spreadsheetTitle:"webhook-log"` /
`serviceAccount.keyFile:"/app/secrets/<鍵>.json"`(read-only マウントから読めている)。
`POST /refresh` はコンテナ内から差分 3 行だけを HTTP 1 本で取得。

ブラウザ実機(ダーク・1512px)で確認: タブ 4 枚、3 ソースのバッジ、重要度フィルタ(15/417 件)、
「自動調査ありのみ」フィルタ(2 件→ 再アタッチ後は 7 行)、行展開(自動調査の要約 / サイト状況 KPI /
生データ)、「調査する」→ ネットワーク調査タブでクエリとサイトが事前入力される、
実行タイムラインに「自動調査」タグ付きの 2 件。**コンソールエラーなし**。

---

## 変更・追加ファイル一覧

```
plugins/webhook-feed/feed-types.ts            新規。統合スキーマ・自動調査・先読みの共有型
plugins/webhook-feed/sheets-client.ts         新規。サービスアカウント認証・差分 batchGet・シリアル値→ISO
plugins/webhook-feed/mapping.ts               新規。3 シート → 統合スキーマの変換(差異はここだけ)
plugins/webhook-feed/enrich.ts                新規。Task 4/5 の共通トリガー・重複防止・直列キュー
plugins/webhook-feed/poller.ts                新規。ポーリング・差分状態・キャッシュ・設定の永続化
plugins/webhook-feed/api.ts                   新規。/snapshot /refresh /settings /status
plugins/webhook-feed/view/types.ts            新規。サーバ型のミラー
plugins/webhook-feed/view/api.ts              新規。fetch ラッパ
plugins/webhook-feed/view/investigate.ts      新規。「調査する」/ 追加質問のクエリ組み立て
plugins/webhook-feed/view/WebhookFeed.tsx     新規。Webhook ログ タブ本体
plugins/webhook-feed/view/styles.css          新規。wf-*(ソースバッジ / 行展開 / KPI / 生データ)
plugins/network-investigation/api.ts          source に "auto" を追加、runAutoInvestigation を公開
plugins/network-investigation/view/session.ts SOURCE_LABEL(手動 / 定期 / 自動調査)を追加
plugins/network-investigation/view/types.ts   HistoryRecord.source に "auto"
plugins/network-investigation/view/Turn.tsx   タグ表示を SOURCE_LABEL 経由に
plugins/network-investigation/view/Timeline.tsx 同上
plugins/network-investigation/view/styles.css .ni-tag.auto(アンバー)
server/index.ts                               /api/webhook-feed をマウント、initWebhookFeed
src/main.tsx                                  タブ「Webhook ログ」を追加(4 枚構成)
docker-compose.yml                            WEBHOOK_* env、./secrets:/app/secrets:ro マウント
Dockerfile                                    /app/data/webhook-feed を作成
.dockerignore                                 secrets を除外
.env.example                                  Webhook ログ関連の環境変数を追記
package.json                                  googleapis を追加
```

`npx tsc --noEmit` / `npx vite build` 通過。git 操作は行っていない。

---

## 未対応・申し送り

- **Apps Script が New Central の Site ID を数値で書いている**ため、17 桁のサイト ID は
  シートの時点で丸まっている。文字列として書き込むよう Apps Script 側を直すのが恒久対策。
- `Debug` シートは取り込み対象外(3 シートのみ)。
- Mist の `audits` / `client-info` など重要度を持たない topic は `unknown` 扱いで、
  自動調査の対象にならない。必要になったら topic ごとの重要度マッピングを足す。
- 自動調査の要約は素の文字列として表示している(ネットワーク調査タブのような Markdown 描画はしていない)。
