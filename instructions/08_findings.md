# 08 findings — 失敗の可視化(個別ツール呼び出しのエラー詳細 + 全体障害時のUI検証)

対象: `instructions/08_failure_visibility.md`
実施日: 2026-07-23

---

## Task 1: 個別ツール呼び出しの失敗理由を UI で確認できるようにする

### 1-1. エラー情報がどこまで保持されていたか(調査結果)

`claude` CLI を `--output-format stream-json --verbose` で起動したときの NDJSON を実測した。
MCP ツールが失敗すると、`user` イベントの `tool_result` が **`is_error: true` になり、
`content` に MCP サーバーが返したエラー本文がそのまま入っている**。

実測(mist-cloud):

```json
{"type":"tool_result","tool_use_id":"toolu_…","is_error":true,
 "content":"Tool error: param \"query_type\" is required for insight_type \"sle\": SLE operation to perform. Org-level: sites_sle, org_metric. Site-level: summary, …"}
```

つまり **エラー情報は claude CLI の出力に含まれていた**。捨てていたのはアプリ側で、場所は
`plugins/network-investigation/insight-agent.ts` の `onEvent`(tool_result 分岐)。
`estimateCount(e.text)` で件数を推定するためだけに本文を使い、`status: "error"` だけを
`McpCallEvent` に載せて本文を破棄していた。

### 1-2. 実装(保持 → SSE → 履歴 → UI 展開)

| 層 | ファイル | 変更 |
|---|---|---|
| 抽出 | `insight-agent.ts` | `McpCallEvent` に `error` / `errorStatus` / `input` を追加。`is_error` のときだけ本文(先頭 1200 字)・HTTP ステータス・**呼び出し引数の全文 JSON**(600 字)を載せる |
| 配信 | `api.ts` | `HistoryToolCall` に同 3 フィールドを追加。SSE は `broadcast({type:"mcp_call", ...e})` なのでそのまま流れる。履歴 jsonl にも保存 |
| 受信 | `view/NetworkInvestigation.tsx` | SSE ハンドラが `McpCall` を1フィールドずつ再構築していたため、新フィールドを追記(ここを忘れると実行中ログにだけ出ない) |
| 受け渡し | `view/session.ts` | `turnFromRun()` の calls マッピングにも追記 |
| 表示 | `view/ToolCallRow.tsx`(新規) | 失敗行だけを `<details>` にする共有部品。実行中ログ(SseLog)と履歴ターン(Turn)の両方がこれを使う |
| 表示 | `view/SseLog.tsx` / `view/Turn.tsx` | 行の描画を `ToolCallRow` に置き換え(重複していた行描画を1箇所に集約) |
| 見た目 | `view/styles.css` | `.ni-call-fail` 系。失敗行の右端に `▸ / ▾` キャレット、展開部は赤枠の淡い背景 + `pre`(折返し・最大高 260px) |

**引数の全文を出しているのが要点**。ヘッダの要約(`summarizeInput`)は
「先頭 2 項目まで・オブジェクト値は捨てる」仕様なので、今回の失敗のように
「`params` の中身が足りない」ケースは要約からは絶対に判断できない。

### 1-3. 実際の表示(再現済み)

クエリ「<SITE_A> サイトのローミング劣化の原因(AP配置・チャネル・電波干渉)を調べて」で
`get_mist_insights` が失敗し、その行をクリックすると以下が展開される:

```
[ステータスコードなし]  MCP サーバー(mist-cloud)が返したエラー
Tool error: param "query_type" is required for insight_type "sle": SLE operation to perform.
Org-level: sites_sle, org_metric. Site-level: summary, impact_summary, summary_trend,
impacted_applications, impacted_aps, … , classifier_summary_trend, metrics, classifiers

呼び出し引数
{"insight_type":"sle","site_id":"<MIST_SITE_ID>","params":{"scope":"site","scope_id":"<MIST_SITE_ID>","metric":"roaming"},"duration":"1d"}
```

ステータスコードは 3 系統の言い回し(`HTTP 403` / `status: 400` / `Error 429:`)を正規表現で拾う。
拾えないときは「ステータスコードなし」と明示する(黙って空欄にしない)。
Task 3 の Global Overview 側では実際に HTTP 401 を含む本文が出ているので、
コードが本文に含まれる MCP サーバーであればバッジに `HTTP 401` と出る。

---

## Task 2: 個別ツール失敗の原因(判明分)

### `get_mist_insights(insight_type=sle)` — **想定内の制限ではなく、呼び出し方の誤り**

エラー本文:

> `Tool error: param "query_type" is required for insight_type "sle"`

モデルが `params` に `scope` / `scope_id` / `metric` は入れたが、**必須の `query_type` を入れていない**。
ライセンス不足でも権限不足でもなく、**引数不足(パラメータ不正)**。

裏取り: 同じ org に対し `params={"query_type":"sites_sle"}` を付けて直接呼ぶと成功する
(9 サイト分の SLE が返る)。したがって org/サイト側のライセンス・権限には問題がない。

また、同じセッション内でモデルが 2 回目以降に `query_type` を付け直して呼び直すと成功しており、
**リトライで自己回復している**(だから最終回答は成立していた)。実害は「1 回分の無駄な往復」。

### `get_mist_config`(org_id + site_id で失敗していた件)— **同じくスコープ指定の誤り**

07 以前の履歴に残る失敗は `detail` が `org_id=…, site_id=…` までしか出ておらず
`resource_type` が見えていなかった。同等の呼び出しを直接再現すると:

> `Tool error: resource_type "rftemplates" does not support site scope; omit site_id or use a resource type that supports site scope`

つまり **org スコープ専用のリソース種別に site_id を付けた**ための 400 相当。これも制限ではなく引数の誤り。
なお今回 Task 1 実装後に同じ意図のクエリ(AP03 の RF テンプレート確認)を流したときは
`get_mist_config(resource_type=devices)` が成功し、失敗は再現しなかった(モデルの呼び方次第で出たり出なかったりする)。
→ **上記の直接再現による裏取りであり、アプリ経由での再現ではない**点は明記しておく。

### 結論

現在確認できている Mist 側の失敗は、いずれも **MCP サーバーの入力検証エラー(引数不足・スコープ違反)**。
ライセンス/権限による「想定内の制限」ではない。UI の展開表示で、この切り分けが画面から直接できるようになった。

---

## Task 3: 全体障害時(認証情報無効)の UI 検証

**本番の `.env` と `~/.claude.json` は一切変更していない。** すべて scratchpad 上のコピー
(`--env-file` / compose オーバーライドでのマウント差し替え)で実施し、検証後に削除した。

### 3-1. Global Overview — 片系(Mist)のみ無効

`MIST_API_TOKEN` を無効値にしたコピーで起動 → `POST /refresh`。

- Central パネル: `接続 OK` のまま正常表示(13 サイト / 17 クライアント)
- Mist パネル: **`取得失敗` タグ + 赤枠のインラインエラー**
  `Mist api/v1/orgs/c4669636-…/stats/sites が HTTP 401: {"detail":"Invalid token."}`
- 数値は 0、ドーナツはグレー表示
- 上部の合計カードは Central 分だけを合算して表示

→ **どちらのプラットフォームが落ちているか・HTTP ステータス・API パスまで画面から分かる**。

### 3-2. Global Overview — 両系無効

`CENTRAL_CLIENT_SECRET` と `MIST_API_TOKEN` の両方を無効値にし、**永続キャッシュを消してから**起動。

- Central: `取得失敗` + `Central トークン取得に失敗: HTTP 401 {"error":"unauthorized_request"}`
- Mist: `取得失敗` + `… が HTTP 401: {"detail":"Invalid token."}`
- 総サイト数 / デバイス / クライアント / アラートはすべて 0、サイトマップは 0/0 サイト

**注意(仕様として確認した挙動)**: `poller.ts` は「両系失敗 かつ 既存キャッシュあり」のときは
既存キャッシュを保持する(`両プラットフォームの取得に失敗。既存キャッシュを保持します。`)。
そのため、**キャッシュが残っている状態で認証情報を壊しても画面は正常な古いデータを出し続ける**
(`最終更新` の時刻と `古い可能性` タグでしか気付けない)。上記の検証はキャッシュを消して行った。

### 3-3. スナップショット未生成(503 相当)の初期表示

初回ポーリングが完了しない状況を作るため、`CENTRAL_BASE_URL` / `MIST_BASE_URL` /
`CENTRAL_TOKEN_URL` を到達不能アドレス(`https://10.255.255.1`)に向け、
`data/global-overview/snapshot.json` を消して起動。

- `GET /api/global-overview/snapshot` → **HTTP 503**
  `{"error":"スナップショット未生成です。初回ポーリングの完了を待ってください。","snapshot":null,…}`
- 画面: **赤いエラーバナー「スナップショット未生成です。初回ポーリングの完了を待ってください。」**、
  `最終更新 —(—)` + `古い可能性` タグ、パネル類は非表示(空振りのグラフを描かない)

### 3-4. ネットワーク調査ページ — claude CLI の認証情報が無効

`CLAUDE_CODE_OAUTH_TOKEN` を無効値にして実行。

- ターンに **`失敗` タグ**、タイムラインの点も赤 + `失敗` タグ
- 呼び出したツール(0)
- 失敗理由(**今回改善した箇所**):
  `claude exited 1: HTTP 401 — Failed to authenticate. API Error: 401 OAuth access token is invalid.`

**改善前は `claude exited 1:` の 1 行だけだった。**
原因: `runClaudeWithMcp` の `close` ハンドラが「終了コード ≠ 0 なら stderr を理由にする」判定を
最初に行っていたが、claude CLI は認証失敗時 **stderr が空**で、原因は stdout の result イベント
(`{"type":"result","is_error":true,"api_error_status":401,"result":"Failed to authenticate. …"}`)
にしか載らない。→ 非ゼロ終了時もまず result イベントから理由を拾うよう `mcp.ts` を修正
(`failureReasonFromEvents()` / `describeResultError()` を追加。HTTP ステータスと本文の両方を残す)。

### 3-5. ネットワーク調査ページ — Mist MCP のトークンだけ無効(既知の弱点)

`~/.claude.json` のコピーで mist-cloud の Bearer を壊してマウントし、Mist 向けクエリを実行。

- `mcp-remote` が **MCP ハンドシェイク段階で失敗**し、mist-cloud のツールが 1 つも登録されない
- 結果: **ツール呼び出しは 0 件 → 個別行の失敗表示は出ない**
- 実行は `isError: false`(成功扱い)で終わり、回答本文が
  「mist-cloud のツールが引き続き見つかりません…接続が完了していないか、利用できない可能性があります」
  というモデルの地の文になる
- サーバーログにも MCP の認証失敗は残らない(claude の stderr は非ゼロ終了時しか読んでいないため)

→ **`失敗` タグが付かず、画面上は「一応答えが返った実行」に見える**。これは今回のスコープ外なので
実装は変更していないが、失敗の可視化としては次に埋めるべき穴。NEXT に記載。

### 3-6. 復元確認

- `docker compose up -d --force-recreate`(本番 `.env` / 本来の `~/.claude.json` マウント)で復帰
- `GET /health` → `mcpConfig.source=live, servers=[central-mcp, mist-cloud]`
- `GET /api/global-overview/status` → `central: ok=true`, `mist: ok=true`
- Global Overview 画面: 22 サイト(Central 13 / Mist 9)、54 デバイス、28 クライアント、両パネル `接続 OK`
- ネットワーク調査で「全サイトの健全性を確認して(復旧確認)」を実行 →
  `central_get_summary` / `get_mist_self` / `get_mist_stats` / `get_mist_insights` /
  `central_get_alerts` がすべて `done`、回答生成成功(`isError: false`)
- コンテナのマウントが `/Users/kshimono/.claude.json → /host/claude.json` に戻っていることを `docker inspect` で確認
- 検証用の資格情報コピー(`.env.broken-*` / `broken-claude.json` / probe 用 mcp-config)はすべて削除

---

## 変更ファイル一覧

```
plugins/network-investigation/insight-agent.ts      失敗詳細の抽出(error/errorStatus/input)
plugins/network-investigation/mcp.ts                非ゼロ終了時の理由を result イベントから拾う
plugins/network-investigation/api.ts                HistoryToolCall に失敗詳細を追加・履歴へ保存
plugins/network-investigation/view/types.ts         ToolCallFailure を McpCall / HistoryToolCall に混ぜる
plugins/network-investigation/view/ToolCallRow.tsx  新規。失敗行を <details> で展開する共有部品
plugins/network-investigation/view/SseLog.tsx       行描画を ToolCallRow へ集約
plugins/network-investigation/view/Turn.tsx         行描画を ToolCallRow へ集約
plugins/network-investigation/view/NetworkInvestigation.tsx  SSE ハンドラで失敗詳細を引き継ぐ
plugins/network-investigation/view/session.ts       turnFromRun で失敗詳細を引き継ぐ
plugins/network-investigation/view/styles.css       .ni-call-fail / .ni-err-* のスタイル
```

`npm run typecheck` 通過。git 操作は行っていない。

---

## NEXT

1. **MCP サーバーに接続できないときの可視化**(3-5)。ツール 0 件で完了した実行に警告を出す、
   もしくは `--print` の system/init イベント(`mcp_servers` の接続状態)を見て
   「mist-cloud に接続できていません」と明示する。現状は成功扱いで埋もれる。
2. **claude CLI の stderr / 非 result エラーを常にサーバーログへ**。現状は非ゼロ終了時しか
   stderr を見ておらず、MCP 接続失敗の痕跡がどこにも残らない。
3. **モデルの引数ミスを減らす**。`get_mist_insights(sle)` は `params.query_type` 必須という
   注意書きを system prompt に足せば、1 回分の無駄な失敗往復を減らせる(現状はリトライで自己回復)。
4. **Global Overview のキャッシュ保持と障害の見分け**(3-2 の注意)。両系失敗時に古いキャッシュを
   出し続ける挙動を、`取得失敗(古いデータを表示中)` のような明示的なタグで示す。
