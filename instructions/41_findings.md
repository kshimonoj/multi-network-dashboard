# 41: 日次レポート生成基盤 — 設計判断と実施結果

実施日: 2026-08-01 / 対象: 作業ツリー(コミットしていない)

> 実データ(サイト名・シリアル番号・site_id/org_id 等)はこの文書では伏字にしている。
> 実際の値は `data/reports/daily/*.json`(gitignore 対象)を参照すること。

---

## 1. 全体構成

新規プラグイン `plugins/reports/`。UI は持たない(42 番)。

| ファイル | 役割 |
|---|---|
| `time.ts` | ローカル TZ での「1 日」の境界計算(`dayWindow` / `dateKeyOf` / `addDays`) |
| `types.ts` | レポート JSON の型。43 番の再集計に耐える形(数値 + 母数)を定義 |
| `store.ts` | 設定 / ファイル入出力 / Retention |
| `sampler.ts` | Global Overview の当日サンプリング(5 分ごと・追記 JSONL) |
| `collect.ts` | 4 ソースから当日分を切り出して集約(外部 API を叩かない) |
| `analyze.ts` | LLM 分析(claude CLI・**MCP なし**・JSON 出力) |
| `generate.ts` | 収集 → 分析 → 保存 の直列実行 + 起動時の後追い生成 |
| `schedule.ts` | node-cron による定期生成(既定 毎日 9:00 に前日分) |
| `api.ts` | `/api/reports/*` ルート + `initReports()` |

既存ファイルへの変更は 4 箇所だけ(いずれも追加のみ):

- `server/index.ts` … `/api/reports` のマウントと `initReports()`
- `plugins/global-overview/mist-client.ts` … `fetchOrgSiteSle()` を追加(SLE を org 一括で 1 本)
- `plugins/central-streaming/store.ts` … `getEventsInRange()` / `retentionDays()` を追加
- `Dockerfile` / `docker-compose.yml` … データディレクトリと運用パラメータ

保存先(すべて `data/` = gitignore 対象):

```
data/reports/settings.json
data/reports/daily/YYYY-MM-DD.json     … 日次レポート本体
data/reports/samples/YYYY-MM-DD.jsonl  … Global Overview の当日サンプル
```

---

## 2. Task 1: 各データソースの「当日分」をどう取ったか

**すべて既存の仕組みからの流用で、外部 API の追加呼び出しは Mist SLE の 1 本のみ。**

### 2-1. Global Overview — サンプリングを新設した(必然)

`poller.ts` は最新スナップショット 1 枚しか持たない(`snapshot.json` を上書き)。
過去に遡る手段が無いので、**当日分を時系列で残す仕組みを足すしかない**。

`sampler.ts` は自前のタイマー(既定 150 秒ごと)で `getCached()` を覗き、
`snapshot.generatedAt` が前回と変わったときだけ 1 行追記する。
→ **Central 側は HTTP 追加ゼロ**(ポーラーが 5 分ごとに作った結果を読むだけ)。

Mist の SLE 総合スコアだけはスナップショットに含まれない
(`aggregate.ts` の `foldMist` は `healthScore: null` を入れている。org 一括の
`stats/sites` が SLE を返さないため)。そこで `MistClient.fetchOrgSiteSle()` を追加し、
`insights/sites-sle` を **org 一括で 1 本** 叩く。既定 30 分間隔 = 1 日 48 本。

- サイト詳細(`fetchMistHealth`)と指標定義を `SLE_METRICS` として共有化した(重複を作らない)。
- 実測: 22 サイト中 Mist 9 サイトで SLE を取得。1 サンプル = 約 4KB。
- サンプルの保持は `sampleRetentionDays`(既定 14 日)。レポート本体(既定 無期限)とは別枠。
  14 日 × 288 サンプル × 4KB ≒ 16MB で頭打ちになる。

**当日サンプルが 0 件の日**(蓄積開始前・後追い生成)は、実行時点のスナップショット 1 点で
代用し、`overview.source: "current-snapshot"` と `notes` に「当日平均ではない」旨を残す。

### 2-2. Webhook ログ — メモリ上のフィードを期間で絞るだけ

`getCachedFeed().items` を `eventAt ?? receivedAt` で当日に絞る。
重要度別・ソース別・カテゴリ別・種別別の件数と、critical / warning の個別行を残す。

保持上限(`WEBHOOK_FEED_MAX_ITEMS` 既定 3000)より古い日は必ず 0 件になるので、
**「本当に 0 件」と「保持から溢れた」を区別する**分岐を入れてある
(手元の最古行がその日の終端より新しければ `available: false` + 理由)。

実測: 2026-07-31 は 2695 件(critical 14 / warning 3 / unknown 2678)。
2026-07-30 以前は保持上限から溢れており 0 件。

### 2-3. Streaming(Central)の Audit Trail — メモリ上のイベントを期間で絞る

`store.ts` に `getEventsInRange(fromMs, toMs)` を追加した(既存の `getEvents()` は
画面配信用に `API_MAX_ITEMS` で頭打ちになるため、日次集計には使えない)。

- ストリーム別の件数を全部数え、`audit-trail` のものだけ個別に残す。
- 実測環境では Streaming が停止中(`settings.enabled: false`)で、保存済み 1000 件は
  2026-07-29 の location-analytics / ap-monitoring のみ。**Audit Trail の実イベントは 0 件**。
  → 期間フィルタが機能していることは 07-29 の 1000 件が正しく拾えることで確認した。
  Audit Trail の実データでの確認は、Streaming を有効化して設定変更が発生したとき。

### 2-4. ネットワーク調査の実行履歴 — jsonl を直接読む

`data/network-investigation/query-history.jsonl` を `ts` で絞る。
`QueryHistoryRecord` は型だけ import している(ランタイム依存を作らない)。

「同じ問題が繰り返し調べられていないか」の手がかりとして、
クエリ文を粗く正規化(空白除去 / 2 桁以上の数字を `#` に / 先頭 80 字)して
サイトとの組で 2 回以上のものを `repeated` に出す。

### 2-5. 接続端末数・トラフィック量

| 項目 | 取得可否 | 根拠 |
|---|---|---|
| 接続端末数 | **取得できた** | Central `sites-health` の `clientCount` / Mist `stats/sites` の `num_clients`。サイト別に平均・ピークを記録 |
| トラフィック量 | **取得できなかった** | 現在の取得経路(Central: `network-monitoring/v1` の sites-health / devices / alerts、Mist: org の `stats/sites` / `stats/devices` / `alarms/search`)に転送量を返すエンドポイントが無い |

Mist SLE の `Throughput` は取得できるが、これは **品質スコア(%)であって転送量ではない**。
混同されないよう、レポートには `traffic: { available: false, reason }` として
理由を機械可読に残し、SLE Throughput は `mistSleMetrics` 側に別途置いた。

---

## 3. Task 2: LLM 分析の設計

### 3-1. enrich.ts(既存の自動事前調査)との違い

| | enrich.ts(17 Task 4) | reports/analyze.ts(41) |
|---|---|---|
| 入力 | 重大アラート **1 件** | **1 日分のデータ全体**(JSON) |
| MCP | 繋ぐ(ライブ情報を取りに行かせる) | **繋がない**(`--strict-mcp-config` + 空 config + 組み込みツールも禁止) |
| 出力 | 散文の回答 | **JSON**(表と再集計に直接使える形) |
| 経路 | `runAutoInvestigation` → `runQuery` → SSE / 履歴 | 独立(SSE にも query-history にも載せない) |

日次レポートは調査ではなく集計なので、履歴タイムラインを汚さないよう完全に別経路にした。

### 3-2. モデル出力のパース方針(CLAUDE.md の i18n 方針)

自然文はパースしない。パースするのは JSON の構造だけで、キー名・列挙値は
日英どちらのプロンプトでも同じ(言語非依存)。応答テキストからの JSON 取り出しは
コードフェンス・前後の地の文に耐えるようにし、失敗時のみ 1 回だけ言い直させる。
CLI の実行そのものが失敗した場合はリトライしない(認証切れ等でコストを重ねない)。

LLM が落ちても `analysis.status="error"` を入れてレポート自体は保存する
(`data` 部は完全な形で残るので、42/43 が数値だけでも使える)。

### 3-3. 再発性は LLM に判定させない

`pastIssues`(過去 14 日ぶんの問題一覧)はプロンプトに渡して所見(`recurrenceNote`)を
書かせるが、**`previousDates` はサーバ側で `key` の完全一致で埋め直す**。
「過去に同じ問題があったか」は照合で確定できる事実で、モデルの記憶に委ねる必要が無いため。

- `key` は正規化(小文字化 / NFKC / `[^a-z0-9:_-]` をハイフンに)してから照合する。
- `status` は `previousDates` から機械的に決める:
  空 → `new` / 前日を含む → `continuing` / それ以外 → `recurring`。

実際に、モデルの `recurrenceNote` が「07-26 にも検出」と書いた項目で `previousDates` は
`["2026-07-30"]` だけ、というケースがあった(07-26 は別の key で記録されていた)。
サーバ側照合を正としているので、表に出る値は破綻しない。

### 3-4. 後追い生成は古い日から

`catchUpMissing()` は `catchUpDays` → 1 の順(**古い日から**)に回す。
新しい日から作ると、先に作った日の過去照合が常に空になる。
初回実装は新しい日からで、生成された 7 日すべてが `過去問題 0 件` になった。

---

## 4. Task 3 / 4: スケジュール・後追い・保持期間

- 定期実行は `node-cron`。`network-investigation/schedule.ts` と同じ骨格
  (コンテナに launchd が無いのでプロセス内に 1 本持ち、設定変更で張り替える)。
  既定 `0 9 * * *` / TZ は `docker-compose` の `TZ`(Asia/Tokyo)。対象は **前日**。
- 起動時の後追いは `REPORTS_CATCHUP_DELAY_MS`(既定 90 秒)遅らせる。
  他プラグインの初回ポーリング前に集計すると「データ無し」と誤判定するため。
- 4 ソースとも空の日はレポートを作らない(`requireData`)。
  MacBook が長期間落ちていた場合に、空のレポートと LLM 呼び出しが量産されるのを防ぐ。
- **未完成レポート(`partial: true`)**: その日が終わる前に作った当日分レポートは
  `partial` を立て、定期実行・後追いのときだけ作り直す。
  手動で当日分を覗いた結果が翌朝 9:00 の正式生成を塞ぐのを防ぐため。
- Retention は 2 本立て: レポート本体 `retentionDays`(既定 0 = **無期限**)、
  サンプル `sampleRetentionDays`(既定 14 日)。
  「保持 N 日」= 今日を含む直近 N 日を残す、と定義した。

---

## 5. 動作確認の実測値(2026-08-01)

| 確認項目 | 結果 |
|---|---|
| サンプリング | 22 サイト(Central 13 / Mist 9)を 1 行 4KB で記録。Mist SLE 9 サイト取得 |
| 収集(2026-07-31) | Webhook 2695 件 / 調査 9 件 / Audit 0 件 / サンプル 0 件 |
| 収集(2026-08-01) | サンプル 10 件から平均・min/max を算出(`source: "samples"`) |
| LLM 分析 | sonnet で 100〜180 秒 / 1 日。attempts=1(リトライ発生なし)で 9 日連続成功 |
| 起きたこと | 5〜7 件。対象機器・発生日時・内容が入った粒度 |
| 問題 | 2〜10 件。根本原因 / 影響範囲 / 次のアクションつき |
| 再発判定 | `continuing` が過去 2〜5 日ぶんの `previousDates` を持つ形で成立 |
| 起動時の後追い | 7 日中 7 日を生成 → 1 件消して再起動 → その 1 件だけを再生成 |
| 保持期間 | `retentionDays=5` にすると 3 件(境界より前)を削除。0 に戻すと削除なし |
| 生成時刻変更 | `PUT /settings {"hour":6,"minute":30}` で cron が `30 6 * * *` に張り替わる |
| レポート 1 件 | 約 30〜60KB(生データ集約 + 分析) |

日次レポートの LLM コストは **1 日 1 回・1 呼び出し**(サイト数に依存しない)。
