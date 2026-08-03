# 33: ネットワーク調査タブの辞書化 + L-5/L-9/L-10/L-11 — 調査・実施結果

実施日: 2026-07-30 / 対象: 作業ツリー(コミットしていない)

---

## 1. Task 1: 対象範囲の再確認

### 1-1. LLM prompt 区分(102 件)は 29 番で対応済み — 二重対応なし

`plugins/network-investigation/insight-agent.ts` を確認した。

- `AgentLang` / `normalizeAgentLang()` / `buildSystemPrompt(bothPlatforms, lang)` が存在し、
  `BASE_SYSTEM_PROMPT` / `BOTH_PLATFORMS_RULE` / `RICH_OUTPUT_RULE` はいずれも
  `Record<AgentLang, string>` で日英 2 本持ちになっている。
- 28 番 §2.6 が最大の論点としていた「モデル出力の日本語パース」は解消済み。
  `[判断] … 不要と判断:` の正規表現は `SKIP_MARKER_RE = /\[SKIP:(central|mist)\]…/i` に
  置き換わり、`detectPlatformJudgments()` / `stripPlatformJudgments()` がマーカーだけを見る。
- → **33 番では insight-agent.ts / ollama-agent.ts のプロンプトには一切触っていない。**

### 1-2. 静的 UI 文言の実測

`plugins/network-investigation/view/` 配下でコメントを除いた「日本語を含む行」数(着手前):

| ファイル | 行 | | ファイル | 行 |
|---|---:|---|---|---:|
| shareText.ts | 41 | | McpHealthNotice.tsx | 9 |
| SessionShare.tsx | 26 | | HistoryThread.tsx | 8 |
| ScheduleEditor.tsx | 22 | | ToolCallRow.tsx | 4 |
| ShareActions.tsx | 21 | | session.ts | 4 |
| NetworkInvestigation.tsx | 19 | | SiteList.tsx | 3 |
| Turn.tsx | 16 | | printClone.ts | 2 |
| Timeline.tsx | 14 | | SuggestedActions.tsx | 1 |
| SseLog.tsx | 13 | | **合計** | **203 行** |

28 番の「UI 文言 220 件」は文言単位、こちらは行単位なので、**規模の記載は妥当**
(1 行に 2 文言ある箇所があるため行数 < 件数)。`tool-labels.json` の 32 ラベルも別途対応した。

対応後の同じ計測は **0 行**(Markdown.tsx / Chart.tsx / Topology.tsx / LogoBadge.tsx /
shareUi.ts / safeHref.ts / types.ts / api.ts は元から UI 文言を持っていなかった)。

---

## 2. 28 番 findings の記載に対する訂正 2 点

後続タスクが誤った前提を引き継がないよう記録する。

### ★ 訂正 1: L-5 は「曜日ボタン 7 個の横並び」ではない

28 番 §4 L-5 は
「`{w}曜` = 2 字 × 7 個 … 7 個横並びの行が溢れる可能性が高い」と書いているが、
実際の `ScheduleEditor.tsx` は **`<select>` 1 個 + `<option>` 7 個**であり、
ボタンの横並びは存在しない(`Timeline.tsx` 側は定期実行サマリ文の中で 1 個だけ使う)。

したがって「7 個ぶんの幅が溢れる」というリスクは発生しない。
`<select>` は内容に応じて自幅を取り、CSS も `.ni-sched-field .ni-select { flex: none; min-width: 90px }`
= 下限のみの指定なので、英語の完全な曜日名でも収まる。**CSS 変更は不要だった。**

### ★ 訂正 2: L-11 の「相対時刻 4 実装」はネットワーク調査タブに無い

指示書 Task 3-4 は「ネットワーク調査タブ側の 4 箇所の実装からも共通で使えるように」とあるが、
`plugins/network-investigation/` に `秒前` 相当の相対時刻実装は **1 つも無い**
(このタブの時刻表示は全て絶対時刻)。

L-11 が指す 4 実装は **他 4 タブ側**:
`GlobalOverview.tsx` / `EventFeed.tsx` / `WebhookFeed.tsx` / `CentralStreaming.tsx` の
`fmtAge()`。30〜32 番で `time.relative.*` 辞書を引くようには直されたが、
**同じ分岐が 4 箇所にコピーされたまま**だった。

→ 指示の意図(重複を 1 箇所に集約し、どのタブからも同じ辞書を使えるようにする)に沿って、
`src/i18n/format.ts` に集約した。ネットワーク調査タブは今のところ利用者ではないが、
同じ窓口を使える状態になっている。

---

## 3. L-5 / L-9 / L-10 / L-11 の対応

| # | 対応 | 確認結果 |
|---|---|---|
| L-5 | 曜日ラベルを `networkInvestigation.schedule.weekday.0〜6` に置き、`session.ts` の `weekdayLabel(t, dow)` に集約(`ScheduleEditor.tsx` と `Timeline.tsx` が共有)。ja は従来と同じ「月曜」、en は完全な曜日名 "Monday"。 | en の最長 "Wednesday" で select 幅 111px・行の overflow なし・`document.body` の横スクロールなし |
| L-9 | 桁揃えの責務をコードから辞書へ移した。`■ 対象サイト : {value}` のように **padding をテンプレートに内包**し、ja は全角スペース / en は半角スペースで整列。箇条書き記号(ja「・」/ en「- 」)と mailto の文字数上限も言語別。 | 実際の共有テキストを両言語で取得して桁揃えを確認(§4) |
| L-10 | `toLocaleString("ja-JP")` のハードコード(表示用 10 箇所)を `src/i18n/format.ts` の `formatDateTime()` / `formatNumber()` に置換。ja は従来と同一出力、en は `en-US` + 24 時間表記(AM/PM で時刻列が伸びるのを避ける)。 | ja `2026/7/30 6:54:06` / en `7/30/2026, 06:54:39`。Webhook ログの受信時刻列で崩れなし |
| L-11 | `fmtAge()` の分岐を `formatRelative()` に集約。Event/Alert・Webhook ログは 30〜32 の時点で 24h 超でも「n 時間前」だったので `{ maxUnit: "hour" }` で挙動を保存。秒数の丸めも `Math.round`(既存と同じ)で揃えた。 | ja「2 分前」= 従来どおり / en "2 minutes ago"(単数複数は辞書のキーで分岐) |

`formatTimestamp()`(shareText.ts)と `fmt()`(Timeline / Turn / HistoryThread)は
**意図的にロケール非依存の `YYYY-MM-DD HH:MM` のまま**残した。理由:

- ISO 8601 風で日英どちらでも誤読しない
- `sessionPeriodLabel()` / `buildSessionMailBody()` が `slice(0, 10)` / `slice(11)` で
  日付部・時刻部を位置で切り出している。ロケール依存にするとこの前提が壊れる

---

## 4. Task 4: srv→UI 文言(61 件)の対応方針

判断基準は 29〜32 番と同じ
= **「特定の閲覧者の言語コンテキストを持つか」**。持つものだけ言語非依存化した。

### 4-1. 対応したもの(2 系統)

いずれもサーバで文章を組み立てず、**機械可読なコード + 値**を返して画面側の辞書で文にする
(CLAUDE.md の i18n 方針 3「モデル出力を自然言語でパースしない」と同じ発想を
サーバ→画面の文言にも適用した)。

| 対象 | 変更 |
|---|---|
| ルーティング理由(`api.ts computeRouting()` の 3 文) | SSE `routing_decision` に `reasonCode: "bothNoSite" \| "siteUnknown" \| "narrowed"` と `reasonParams` を追加。`SseLog.tsx` の `routingReasonText()` が `networkInvestigation.routing.<code>` を引く。従来の `reason`(日本語文)はログ・フォールバック用に残す |
| cron 反映結果(`schedule.ts applySchedule()` の 4 文) | `ScheduleSyncResult` に `detailCode: "disabled" \| "invalid" \| "applied" \| "registerFailed"` と `detailParams` を追加。`ScheduleEditor.tsx` の `scheduleDetailText()` が組み立てる |

`reason` / `detail`(日本語文)を残したのは、`reasonCode` を持たない応答が来ても
画面が空欄にならないようにするため。

**ja の文言が 1 箇所だけ変わる**: cron 反映の weekly ケース。
`毎週 曜日=3(0=日) 07:00(cron …)` → `毎週 水曜 07:00(cron …)`。
番号を英語化すると `Weekly dayOfWeek=3(0=Sun)` という不自然な文になるため、
辞書に曜日名テンプレートを置く方式に変えた(daily / disabled / invalid / registerFailed の
ja 文言は従来と同一)。

### 4-2. 現状維持にしたもの(理由付き)

| 対象 | 理由 |
|---|---|
| `insight-agent.ts` / `ollama-agent.ts` が返す回答本文・`reason` | **実行時の記録**。実行した時点の言語で残るのが正しい(履歴を後から別言語で開いても、その実行が何を答えたかは変わらない)。回答本文と同じ扱い |
| `mcp.ts` / `mcp-health.ts` の MCP 健全性 `reason`(「接続できませんでした」「initialize が HTTP 401: …」等) | 同上。`query-history.jsonl` に永続化され、実行時の診断結果として残る。加えて MCP サーバが返した文言をそのまま載せている箇所があり、翻訳対象として切り分けられない |
| `webhook-feed/enrich.ts:163` の `toLocaleString("ja-JP")` / 「時刻不明」 | 自動事前調査のクエリ生成。**画面を持たないバックグラウンド実行**で、閲覧者の言語が決まらない。生成物は履歴に永続化される(29 番の `lang` 既定 `ja` と整合) |
| `site-map.ts` / `api.ts` のサイト状況取得用 LLM プロンプト | 出力が JSON のみで、文言が画面に出ない |
| `api.ts` の `{ error: "failed to read site map" }` 系 | 既に英語。画面では `String(e)` として開発者向けに出る |
| console ログ(約 120 件) | 運用者がサーバログを読むためのもの。28 番の時点から i18n 対象外 |
| `api.ts getSummary()` の `label: "ネットワーク調査"` / `countLabel` | **呼び出し元が存在しない**(`GET /api/home/summary` を消費するコードが無く、`getSummary` の参照は定義箇所のみ)。画面に出ないので対応不要。将来 Home 概要を作る際は辞書化が必要 |

---

## 5. 追加で直したこと(検証中に見つけた不具合)

- **cron 反映メッセージが言語切替に追従しなかった。**
  最初の実装は「押した時点の言語で組み立てた文字列」を state に持っていたため、
  保存後に言語を切り替えるとこの 1 行だけ前の言語で残った。
  応答(`LaunchdSyncResult`)そのものを state に持ち、**描画時に文にする**ように直した。
- **`NetworkInvestigation.tsx` の「状態取得」日時がロケール指定なしの `toLocaleString()`** だった
  (= ブラウザ既定依存。他タブの `ja-JP` 固定とも揃っていなかった)。`formatDateTime()` に統一。
- **`summarizeAnswer()` の箇条書き剥がし**が `^[・\s]+` 固定だった。
  英語の記号を一律に足すと `-5% degradation` の先頭 `-` まで削るので、
  **今の言語の記号を空白込みのまま**剥がす形にした。
