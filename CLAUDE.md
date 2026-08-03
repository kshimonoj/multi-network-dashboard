# multi-network-dashboard — プロジェクト固有ルール

Central / Mist 横断のネットワーク調査ダッシュボード。
`src/` がシェル(タブ・テーマ・i18n)、`plugins/<name>/` が各タブの実装(サーバ側 `*.ts` + `view/` の React)。

## i18n(表示言語の日英切替)

言語基盤は `src/i18n/` にある(29 番で構築)。追加ライブラリは使わず、
JSON 辞書 + 軽量 Context(ダークモード切替と同じパターン)で実装している。

- 辞書: `src/i18n/ja.json` / `src/i18n/en.json`
- Context / フック: `src/i18n/LanguageContext.tsx`(`useT()` / `useLanguage()`)
- React 外から現在の言語を読む窓口: `src/i18n/i18n.ts` の `getLang()`
- 永続化: `localStorage["mnd-lang"]`。既定は `ja`。`<html lang>` は `index.html` の
  インラインスクリプトが初期反映し、切替時は `applyLang()` が追従する

### 守ること

1. **UI に新しい文言を追加するときは、必ず `src/i18n/ja.json` と `src/i18n/en.json` の
   両方に対応するキーを追加する。** 片方だけ追加しない。
   コンポーネントに日本語(または英語)の文字列を直書きしない。

   ```tsx
   const t = useT();
   <button>{t("tabs.webhookFeed.label")}</button>
   ```

   キーはドット区切り(`tabs.webhookFeed.label`)。未定義キーは `ja` にフォールバックし、
   それも無ければキー文字列がそのまま画面に出る = 追加漏れに気付ける設計にしてある。

2. **動的に組み立てる文字列(クエリ生成・共有テキスト・印刷レイアウト・通知文等)を
   新設する場合も、日英両方のテンプレートを用意する。**
   文字列連結でその場に文章を作らず、プレースホルダ付きのテンプレートを辞書に置き、
   `t("key", { name: value })` で埋める。

   ```json
   { "theme": { "toggleAria": "{next}モードに切り替える" } }
   ```

   サーバ側で生成して画面に届く文言(API の `error` / `note` / `reason` 等)も同じ扱いにする。

3. **モデル出力を自然言語でパースする実装を作らない。**
   LLM に何かを宣言させたいときは、`[SKIP:central]` のような**言語非依存の機械可読マーカー**を
   出力させ、それだけを検出する。プロンプトを日英で切り替えても壊れないようにするため。

   - 実例: `plugins/network-investigation/insight-agent.ts` の
     `detectPlatformJudgments()` / `stripPlatformJudgments()`。
     以前は `[判断] Central は不要と判断: <理由>` を正規表現で読んでいたが、
     回答言語を英語にすると無言で一致しなくなるため、マーカー方式に置き換えた。
   - マーカーは**日英どちらの system prompt にも同じ形で**指示する
     (`buildSystemPrompt(bothPlatforms, lang)`)。翻訳・全角化を禁止する一文も入れる。
   - マーカーは内部判定にだけ使い、**ユーザーに見せる回答本文からは必ず取り除く**。

### Insight Agent の回答言語

UI の表示言語と Insight Agent の回答言語は連動する。

```
UI(src/i18n の現在言語)
  → view/api.ts runQuery() が POST /api/network-investigation/query の body.lang に載せる
  → api.ts runQuery(..., lang)
  → runInsightAgent / runOllamaAgent の opts.lang
  → buildSystemPrompt(bothPlatforms, lang) で system prompt をまるごと切替
```

- 定期実行・Webhook の自動事前調査は画面を持たないので、既定の `ja` で動く
- `lang` を送ってこないクライアントも `normalizeAgentLang()` が `ja` に倒す(挙動は従来どおり)

### 日時 / 数値 / 相対時刻の整形

**`toLocaleString("ja-JP")` を直接書かない。** 表示用の整形は `src/i18n/format.ts` に集約してある
(33 番。それ以前は各タブが同じ関数をコピーし、ロケールをハードコードしていた)。

- `formatDateTime(iso, lang?, fallback?)` … `ja` → `2026/7/30 6:54:06` / `en` → `7/30/2026, 06:54:39`
  (en も 24 時間表記。AM/PM を出すと時刻列の固定幅を超える)
- `formatNumber(n, lang?)` … 桁区切り
- `formatRelative(t, elapsedMs, opts?)` … 「n 秒前」/ `n seconds ago`。辞書は `time.relative.*`。
  英語の単数/複数は辞書のキー(`…AgoOne` / `…AgoOther`)で分ける。
  `opts.maxUnit: "hour"` は Event/Alert・Webhook ログ用(24h を超えても「n 時間前」で止める既存挙動)

`lang` 省略時は `getLang()` を読む。React 側は言語 Context の変化で再描画されるので、
呼び出し側が `lang` を持ち回る必要はない(持っている場合は渡してよい)。

一方で **`YYYY-MM-DD HH:MM` 形式の整形はロケール非依存のまま**にしてある
(`view/shareText.ts` の `formatTimestamp()`、`Timeline` / `Turn` / `HistoryThread` の `fmt()`)。
日英どちらでも誤読せず、`slice(0, 10)` / `slice(11)` で日付部・時刻部を位置で切り出す
コード(`sessionPeriodLabel()` 等)が成立するため。ここをロケール依存にしないこと。

### サーバ生成の文言を画面に出すとき

サーバは**閲覧者の表示言語を知らない**(SSE は全クライアントに配信され、cron は画面を持たない)。
そこでサーバ側で文章を組み立てず、**機械可読なコード + 値**を返し、画面側の辞書で文にする。
辞書化しきれない場合のフォールバック用に、従来の日本語文も同じ応答に残す。

- 実例: SSE `routing_decision` の `reasonCode` / `reasonParams`
  (`plugins/network-investigation/api.ts` → `view/SseLog.tsx` の `routingReasonText()`)
- 実例: `PUT /schedule-config` の `detailCode` / `detailParams`
  (`plugins/network-investigation/schedule.ts` → `view/ScheduleEditor.tsx` の `scheduleDetailText()`)

逆に、**実行時の記録として残る文言は翻訳しない**。Insight Agent の回答本文・失敗理由、
MCP 健全性の `reason`、バックグラウンドの自動事前調査が生成したクエリ文などが該当する
(履歴を後から別言語で開いても「その実行が何を答えたか」は変わらないため)。

### 言語で切り替わる文字列を state に文として持たない

「押した時点の言語で組み立てた文字列」を `useState` に入れると、その後の言語切替に追従せず
その 1 行だけ前の言語で残る。**素材(サーバ応答・コード)を state に持ち、描画時に `t()` で文にする。**

### 辞書化の進捗

- 共有 / シェル(タブ名・テーマトグル・言語切替)… 完了(29 番)
- Global Overview / Event / Alert … 完了(30 番)
- Webhook ログ … 完了(31 番)
- Streaming(Central)… 完了(32 番)
- ネットワーク調査 … 完了(33 番)。画面・共有テキスト・印刷レイアウト・
  MCP ツールラベル(`plugins/network-investigation/tool-labels.json` の `labels` / `labelsEn`)まで含む
- レイアウト崩れ懸念 L-5 / L-9 / L-10 / L-11 … 対応済み(33 番)
- 棚卸し結果は `instructions/28_findings.md`、33 番の実施結果と
  **28 番の記載に対する訂正 2 点**は `instructions/33_findings.md`
