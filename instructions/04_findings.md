# 04 — 「続けて調べる」のセッション化 調査結果(Task 1)

調査日: 2026-07-23
対象: `plugins/network-investigation/`(api.ts / insight-agent.ts / view/*)、`data/network-investigation/query-history.jsonl`

---

## 1. `query-history.jsonl` のスキーマ(実データ)

`data/network-investigation/query-history.jsonl` = 9 レコード(2026-07-23 時点)。
全レコードのキー出現数を数えた結果:

| フィールド | 出現 | 型・内容 |
|---|---|---|
| `id` | 9/9 | runId(`randomUUID()`)。SSE の runId と同一 |
| `ts` | 9/9 | ISO8601(`new Date().toISOString()`、実行開始時刻) |
| `query` | 9/9 | クエリ文字列 |
| `site` | 9/9 | サイト名 or `null`(指定なし) |
| `resolvedPlatform` | 9/9 | `"central" \| "mist" \| null` |
| `platformsUsed` | 9/9 | 実際に `--mcp-config` に含めた platform 配列 |
| `mcpServers` | 9/9 | MCP サーバー名配列 |
| `source` | 9/9 | `"manual" \| "scheduled"` |
| `answerExcerpt` | 9/9 | 回答先頭 200 文字 |
| `isError` | 9/9 | boolean |
| `answer` | 9/9 | 回答全文(suggested-actions ブロック除去済み) |
| `calls` | 9/9 | `HistoryToolCall[]`(最終状態) |
| `judgments` | 9/9 | `PlatformJudgmentEvent[]` |
| `suggestedActions` | 9/9 | `SuggestedAction[]`(= 「続けて調べる」チップの元) |
| `model` | 7/9 | 旧レコード 2 件には無い(既に後方互換の前例がある) |
| `reason` | 0/9 | 失敗時のみ付く(このデータには失敗レコードが無い) |

**紐付けフィールドは存在しない。** `sessionId` / `parentId` / `threadId` に相当するものは
1 件も無く、単に時系列のフラットな列。`GET /history` も `ts` 降順に並べて全件返すだけ
(`api.ts:238-247`)。

## 2. 「続けて調べる」の実装(フロントエンド)

**「続けて調べる」= `SuggestedActions.tsx` のチップ**(`ni-suggested-label` の文言がそのまま
「続けて調べる」)。回答本文の末尾に モデルが出力した ```` ```suggested-actions ```` ブロックを
サーバー(`insight-agent.ts:110 extractSuggestedActions`)が切り出したもの。

クリック時の経路:

```
SuggestedActions onClick(a.query, a.site)
  → NetworkInvestigation.onRunAction(query, site)      (NetworkInvestigation.tsx:219)
      setQueryText / setSelectedSite / setDetailRecord(null)
      → startRun(query, site, selectedModel)           (:191)
          → POST /api/network-investigation/query { query, site, model }   (view/api.ts:109)
              → runQuery(randomUUID(), …)              (api.ts:263)
                  → runInsightAgent(query, site, …)    (insight-agent.ts:201)
                      → runClaudeWithMcp({ prompt: q, … })
```

### 2-1. 前回の回答・会話コンテキストの引き継ぎ: **していない**

- `runClaudeWithMcp` に渡るのは `prompt: q`(= チップの `query` 文字列)だけ。
  `--resume` / `--continue` / セッションID の類は一切使っておらず、
  **毎回まっさらな claude CLI プロセスが起動する**。
- 前ターンの回答本文もツール結果もプロンプトに含まれない。
- 唯一の「文脈の引き継ぎ」は、モデルが `suggested-actions` の `query` を
  **単体で完結する日本語クエリ**として生成している点だけ(system prompt の
  `RICH_OUTPUT_RULE`: 「query はそのまま実行できる完結した日本語クエリにする」)。

→ したがって「セッション」とは、実体としては **会話文脈の連続ではなく「ユーザーの調査の流れ
(=どの回答から派生したか)」のグルーピング**である。この事実が設計判断に直結する(4章)。

### 2-2. 紐付けは React state にも残っていない

`startRun` は新しい runId を `runsRef`(Map)へ入れて `displayRunId` を差し替えるだけで、
「どの回答から派生したか」を指す親ポインタは持たない。前ターンの `RunState` は Map に
残り続けるが、参照する手段が無い(表示は常に `displayRunId` の 1 件のみ)。

**結論: 紐付けはサーバー保存時に失われるのではなく、そもそもフロント・サーバーのどちらにも
生成されていない。**

## 3. 履歴詳細画面(`.ni-detail-block`)の現状

`HistoryDetail.tsx` は **`HistoryRecord` を 1 件だけ**受け取って描画する(`record: HistoryRecord`)。
表示内容は「使用プラットフォーム / モデル判断による省略 / 呼び出したツール一覧 / 回答全文」の
4 ブロック。連続した「続けて調べる」の回答同士を繋げる表現は**一切無い**。

`Timeline.tsx` も `history` 配列をそのまま 1 レコード 1 カードで縦に並べるだけなので、
3 回続けて掘り下げた調査は **バラバラの 3 枚のカード**として時系列に散る(間に定期実行の
結果が挟まればさらに分断される)。

## 4. 設計判断(Task 2 以降の方針)

| 判断 | 内容 | 理由 |
|---|---|---|
| 既存の仕組みを活かすか | **新設する**(既存の紐付けは皆無のため) | 3 章までの通り、活かせる既存フィールドが存在しない |
| どこで採番するか | **View が初回クエリ時に `crypto.randomUUID()`**、`POST /query` の `sessionId` で渡す。未指定ならサーバーが採番 | 「これは前の回答からの派生か」を知っているのは View だけ(サーバーは独立した claude 実行としか見えない) |
| レコードへの持たせ方 | `sessionId` の 1 フィールドのみ追加。ターン番号は持たせない | ターン番号は `ts` 昇順から一意に導出できる。追記専用 jsonl に導出値を焼くと二重の真実になる |
| 後方互換 | 読み込み側で `sessionKey(rec) = rec.sessionId ?? rec.id` に正規化 | `sessionId` の無い旧レコードは「自分 1 件だけのセッション」として自然に扱える。分岐が 1 箇所で済む |
| 会話文脈の引き継ぎ | **今回は実装しない**(2-1 の通り現状も引き継いでいない) | 指示 04 の範囲は「セッション化 + 表示 + 共有」。`--resume` 導入は claude CLI のセッション永続化の設計が別途必要で、スコープ外 |
| 定期実行 | 1 実行 = 1 セッション(サーバーが毎回採番) | 定期実行は派生関係を持たない |

## 5. 実装後のデータ構造(参考)

```jsonc
{
  "id": "…runId…",
  "sessionId": "…セッションID…",   // ★追加。旧レコードには無い
  "ts": "2026-07-23T01:14:28.158Z",
  // 以下は既存のまま
}
```

- 単独クエリ: `sessionId` が付くが、そのセッションに属するのは自分 1 件だけ。
- 旧レコード: `sessionId` なし → `sessionKey = id` として 1 件のセッション扱い。

追加 API: `GET /api/network-investigation/history/session/:sessionId`
→ `sessionKey` が一致するレコードを **`ts` 昇順**で返す(`{ sessionId, records }`)。
