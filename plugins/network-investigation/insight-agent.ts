// Network Investigation — Insight Agent(共通関数・骨格)
//
// PRECONDITIONS:
//  - Insight Agent は独立エージェント化せず「共通関数」として実装する。
//    対話(claude CLI 呼び出し)・スケジューラ(定期実行)・UI ボタン(手動実行)の
//    3 箇所すべてから同じ runInsightAgent() を呼ぶ。
//  - サイト→プラットフォーム対応表に基づき、--mcp-config に該当プラットフォームの MCP サーバー
//    だけを含める(= ルーティングスキップ)。プラットフォーム不明なら両方含める。
//
// このファイルは「共通関数のインターフェース」と「MCP narrowing ロジック」までを確定させる骨格。
// プロンプトの作り込み・SSE での逐次配信は次の指示ファイルで肉付けする。

import type { Platform, McpStreamEvent, McpHealth } from "./mcp.js";
import { ALL_PLATFORMS, runClaudeWithMcp, parseMcpToolName } from "./mcp.js";
import { resolvePlatformForSite, type SitePlatformEntry } from "./site-map.js";

// 回答末尾に付く「クリック可能な追い質問」1件。モデルが ```suggested-actions ブロックで
// 出力し、サーバー側で本文から切り出してこの形にする(Task 1)。
export interface SuggestedAction {
  label: string; // チップに出す短いラベル
  query: string; // クリック時に実行する次のクエリ
  site?: string | null; // 対象サイト(省略可)
}

export interface InsightAgentResult {
  /** ユーザーへ返す回答本文(claude の応答。suggested-actions ブロックは除去済み) */
  answer: string;
  /** 回答本文から切り出した提案アクション(Task 1)。無ければ空配列。 */
  suggestedActions: SuggestedAction[];
  isError: boolean;
  reason?: string;
  /** narrowing の結果 */
  resolvedPlatform: Platform | null; // サイトから引けた platform(引けなければ null)
  platformsUsed: Platform[]; // 実際に --mcp-config に含めたプラットフォーム
  mcpServers: string[]; // 実際に含めた MCP サーバー名
  matchedSite: SitePlatformEntry | null; // 対応表でヒットしたサイト(無ければ null)
  /**
   * MCP サーバーの接続健全性(09)。level!=="ok" なら「回答は返ったが、
   * 一部の MCP サーバーに接続できていなかった(認証切れの可能性)」ことを示す。
   * isError とは独立: 回答自体は成立しているので失敗にはしない。
   */
  mcpHealth?: McpHealth;
}

// MCP ツールの呼び出し/完了を、SSE 配信しやすい形に整えたイベント。
// runInsightAgent の onMcpCall で1件ずつ呼ばれる。
export interface McpCallEvent {
  id: string; // tool_use の id(calling → done/error を同じ行に対応付けるため)
  server: string; // "central-mcp" | "mist-cloud"
  platform: Platform | null; // ロゴバッジの出し分け用
  tool: string; // ツール名(mcp__ 接頭辞を除いたもの)
  status: "calling" | "done" | "error";
  detail?: string; // 引数の要約(例: site=Home)
  count?: number | null; // 結果件数(推定できたとき)
  // ---- 失敗時の詳細(08 Task 1)。status="error" のときだけ載る ----
  // 「想定内の制限(ライセンス/権限)」なのか「呼び出し方の誤り」なのかを画面で判断できるように、
  // claude CLI の tool_result(is_error:true)の本文をそのまま持ち回る。
  error?: string; // エラー本文(先頭 ERROR_TEXT_MAX 文字)
  errorStatus?: number | null; // 本文から拾えた HTTP ステータス(400/403/500 等)。拾えなければ null
  input?: string; // 呼び出し引数の全文 JSON(detail は 2 項目までの要約なので、失敗時は全部見せる)
}

// 「サイト指定なし(両プラットフォーム利用可)なのに、モデルが片方を明示的に不要と判断して
// 省略した」宣言。SYSTEM_PROMPT が指示する `[SKIP:central] <理由>` 行を assistant の
// テキストから検出して1件ずつ流す(サイレントな省略を無くすための見える化)。
export interface PlatformJudgmentEvent {
  platform: Platform; // 不要と判断されて省略されたプラットフォーム
  reason: string; // モデルが示した理由
}

// ---- 回答言語(29 Task 4) ----
//
// UI の表示言語(src/i18n)と Insight Agent の回答言語を連動させる。UI 側が POST /query の
// body.lang で渡してきた値をここまで通し、system prompt をまるごと切り替える。
// 未指定(定期実行・自動事前調査・旧クライアント)は従来どおり日本語。
export type AgentLang = "ja" | "en";

export const DEFAULT_AGENT_LANG: AgentLang = "ja";

export function normalizeAgentLang(v: unknown): AgentLang {
  return v === "en" ? "en" : "ja";
}

// 実運用の system prompt。接続された MCP ツールを実際に呼んで、ライブ情報だけで答えさせる。
// bothPlatforms=true(サイト指定なしで Central/Mist 両方が接続されている)ときだけ、
// 「原則両方使う。省略するなら理由を宣言する」ルールを足す(Task 1)。
const BASE_SYSTEM_PROMPT: Record<AgentLang, string> = {
  ja:
    "あなたは HPE Aruba Networking Central / Juniper Mist を対象とするネットワーク調査アシスタント。\n" +
    "必ず接続された MCP ツールを呼び出し、その結果(ライブ情報)だけに基づいて日本語で簡潔に答える。\n" +
    "- まず概況ツール(Central なら central_get_summary、Mist なら get_mist_self)から呼び、必要に応じて掘り下げる。\n" +
    "- 特定サイトが指定されている場合は、そのサイトに絞って調べる。\n" +
    "- ツールの結果に無いことは推測で答えない。健全性・アラート・端末数など、根拠にした数値を短く添える。\n" +
    "- 回答は要点を箇条書き中心で 5 行程度にまとめる。",
  en:
    "You are a network investigation assistant for HPE Aruba Networking Central and Juniper Mist.\n" +
    "Always call the connected MCP tools and answer concisely in English, based only on their results (live data).\n" +
    "- Start with the overview tools (central_get_summary for Central, get_mist_self for Mist), then drill down as needed.\n" +
    "- If a specific site is given, scope the investigation to that site.\n" +
    "- Never guess anything that is not in the tool results. Cite the numbers you relied on (health, alerts, client counts) briefly.\n" +
    "- Keep the answer to about 5 lines, mostly bullet points.",
};

// 両プラットフォームが接続されている(サイト指定なし)ときだけ付ける追加ルール。
//
// 省略の宣言は「言語非依存の機械可読マーカー」で出させる(29 Task 5)。
// 以前は `[判断] Central は不要と判断: <理由>` という日本語の自然文を正規表現でパースしていたが、
// 回答言語が変わるとパーサが無言で一致しなくなる。日英どちらのプロンプトでも同じ
// `[SKIP:central]` / `[SKIP:mist]` を出させ、検出はこのマーカーだけを見る。
//
// 30 Task 3: 29 番の運用で「モデルが SKIP 宣言を出さずに片方を無言省略する」ケースが
// 見つかったため、最も破りやすい規則(宣言せずに省略する)を箇条書きの先頭に "最重要" として
// 独立させ、「絶対に禁止」まで強調語を強めた。単一の長い箇条書きに埋もれさせない構成にする。
const BOTH_PLATFORMS_RULE: Record<AgentLang, string> = {
  ja:
    "\n\n【重要・複数プラットフォームの利用方針 — 必ず守ること】\n" +
    "- 【最重要】一方のプラットフォームのツールを一度も呼び出さずに回答する場合、その前に必ず次の形式の1行を出力すること。宣言せずに片方を無言で省略することは絶対に禁止:\n" +
    "  [SKIP:central] <省略する理由>\n" +
    "  または\n" +
    "  [SKIP:mist] <省略する理由>\n" +
    "- サイト指定が無いため Central・Mist の両方のツールが利用できる。原則として、両方から関連するツールを呼び出してから回答すること。\n" +
    "- 一方を省略してよいのは、クエリの内容から明らかにそのプラットフォームが無関係だと判断できる場合に限る。省略すると判断した時点で、必ず上記マーカーを先に出力すること。\n" +
    "- マーカー([SKIP:central] / [SKIP:mist])は必ずこの半角の形のまま、行頭に単独で書く。翻訳・装飾・言い換えをしない。理由の部分は日本語で書く。\n" +
    "- 両方のプラットフォームを実際に使った場合は、この宣言を出さない。",
  en:
    "\n\n[Important — using multiple platforms — follow this strictly]\n" +
    "- CRITICAL: If you are about to answer without ever calling a tool on one of the platforms, you MUST emit exactly one line in this format first. Silently skipping a platform without this declaration is strictly forbidden:\n" +
    "  [SKIP:central] <reason for skipping>\n" +
    "  or\n" +
    "  [SKIP:mist] <reason for skipping>\n" +
    "- No site was specified, so both the Central and the Mist tools are available. As a rule, call the relevant tools on BOTH platforms before answering.\n" +
    "- You may skip a platform only when the query makes it unambiguously clear that platform is irrelevant. The moment you decide to skip one, you MUST emit the marker above first.\n" +
    "- Write the marker ([SKIP:central] / [SKIP:mist]) exactly like that, in ASCII, alone at the start of the line. Do not translate, decorate or reword it. Write the reason in English.\n" +
    "- If you actually use both platforms, do not emit this declaration.",
};

// リッチ出力(Task 1-3)の追加ルール。いずれも「必要なときだけ」出す前提。過剰生成させない。
// - suggested-actions: サーバーが本文から切り出し、UI がクリック可能なチップにする。
// - chart / topology: 本文の Markdown 内にそのまま残し、UI が recharts / mermaid で描画する。
const RICH_OUTPUT_RULE: Record<AgentLang, string> = {
  ja:
    "\n\n【任意・リッチ出力】以下は必要と判断したときだけ使う。無理に含めない。不要なら通常の Markdown だけを返す。\n" +
    "1) 追い質問の提案: ユーザーがさらに掘り下げたくなりそうな点があれば、回答本文の末尾に次のフェンスコードブロックを付けてよい(1個まで)。\n" +
    "```suggested-actions\n" +
    '[{ "label": "短いラベル(15文字程度)", "query": "実行する次のクエリ文", "site": "対象サイト名(省略可)" }]\n' +
    "```\n" +
    "  ラベルは簡潔に、query はそのまま実行できる完結した日本語クエリにする。提案が無ければブロックごと出さない。\n" +
    "2) グラフ: グラフが回答の理解を明確に助けると判断した場合のみ、本文の該当箇所に次を埋め込んでよい。\n" +
    "```chart\n" +
    '{ "type": "bar"|"line"|"pie", "title": "…", "data": [{ "label": "…", "value": 数値 }] }\n' +
    "```\n" +
    "3) トポロジ図: サイト・デバイス間の構成関係を図示した方が分かりやすいと判断した場合のみ、本文に次を埋め込んでよい(mermaid 記法)。\n" +
    "```topology\n" +
    "graph TD\n" +
    "  A[サイト名] --- B[デバイス名]\n" +
    "```\n" +
    "  数値の羅列で足りるものにグラフを、単純な構成にトポロジ図を無理に付けない。",
  en:
    "\n\n[Optional — rich output] Use the following only when it genuinely helps. Do not force it. If none applies, return plain Markdown.\n" +
    "1) Follow-up suggestions: if there is an obvious next thing the user would want to dig into, you may append this fenced block at the very end of the answer (at most one).\n" +
    "```suggested-actions\n" +
    '[{ "label": "short label (~25 chars)", "query": "the next query to run", "site": "target site name (optional)" }]\n' +
    "```\n" +
    "  Keep the label short; `query` must be a complete, directly runnable query written in English. If you have no suggestion, omit the block entirely.\n" +
    "2) Chart: only if a chart clearly helps understanding, embed this where it belongs in the answer.\n" +
    "```chart\n" +
    '{ "type": "bar"|"line"|"pie", "title": "…", "data": [{ "label": "…", "value": number }] }\n' +
    "```\n" +
    "3) Topology: only if drawing the site/device relationships makes things clearer, embed this (mermaid syntax).\n" +
    "```topology\n" +
    "graph TD\n" +
    "  A[Site name] --- B[Device name]\n" +
    "```\n" +
    "  Do not attach a chart to a couple of numbers, or a topology diagram to a trivial structure.",
};

// Ollama 版(ollama-agent.ts)も同じ system prompt を使う(比較モードで回答の前提を揃えるため)。
//
// knowledge(47): 承認済みナレッジから作った「関連する既知の情報」セクション。
// 本文と見出しは plugins/knowledge/retrieve.ts が回答言語に合わせて組み立てて渡してくる
// (ナレッジの中身を network-investigation 側が知らずに済むように、ここでは末尾に足すだけ)。
// マッチが無ければ空文字 / undefined が来るので、その場合は従来とまったく同じ prompt になる。
export function buildSystemPrompt(
  bothPlatforms: boolean,
  lang: AgentLang = DEFAULT_AGENT_LANG,
  knowledge?: string,
): string {
  const l: AgentLang = lang === "en" ? "en" : "ja";
  const base = bothPlatforms ? BASE_SYSTEM_PROMPT[l] + BOTH_PLATFORMS_RULE[l] : BASE_SYSTEM_PROMPT[l];
  const k = (knowledge || "").trim();
  return base + RICH_OUTPUT_RULE[l] + (k ? `\n\n${k}` : "");
}

// 回答本文から ```suggested-actions フェンスブロックを検出・切り出す(Task 1)。
// 本文からはブロックを除去し、パースできた提案アクションだけを返す。
// chart / topology ブロックは本文にそのまま残す(UI 側で描画するため、ここでは触らない)。
const SUGGESTED_ACTIONS_RE = /```suggested-actions[^\n]*\n([\s\S]*?)```/g;

export function extractSuggestedActions(answer: string): { answer: string; suggestedActions: SuggestedAction[] } {
  const src = answer || "";
  const actions: SuggestedAction[] = [];
  let m: RegExpExecArray | null;
  SUGGESTED_ACTIONS_RE.lastIndex = 0;
  while ((m = SUGGESTED_ACTIONS_RE.exec(src))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        const label = typeof (it as any).label === "string" ? (it as any).label.trim() : "";
        const query = typeof (it as any).query === "string" ? (it as any).query.trim() : "";
        if (!label || !query) continue;
        const siteRaw = (it as any).site;
        const site = typeof siteRaw === "string" && siteRaw.trim() ? siteRaw.trim() : null;
        actions.push({ label, query, site });
      }
    } catch {
      /* パースできないブロックは無視して本文からは除去する */
    }
  }
  const cleaned = src.replace(SUGGESTED_ACTIONS_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer: cleaned, suggestedActions: actions };
}

// ---- プラットフォーム省略マーカーの検出(29 Task 5) ----
//
// assistant のテキストから `[SKIP:central] <理由>` / `[SKIP:mist] <理由>` を検出する。
// 旧実装は `[判断] Central は不要と判断: …` という日本語の自然文を正規表現でパースしていたが、
// 回答言語を切り替えた瞬間に無言で一致しなくなる(= 省略が画面に出ない)ため、言語に依存しない
// 固定マーカーへ置き換えた。後方互換は取らない(旧履歴の judgments は保存済みの値がそのまま出る。
// 旧回答本文を再パースすることは無い)。
//
// 許容する揺れは最小限に留める: 大文字小文字、[SKIP:central] の直後の区切り記号(: / : / -)、
// 理由が無い場合。マーカー自体の全角化・翻訳は認めない(プロンプトでも明示的に禁じている)。
const SKIP_MARKER_RE = /\[SKIP:(central|mist)\][ \t]*[:：\-—]?[ \t]*([^\n]*)/gi;

// マーカーを含む行を丸ごと落とすための正規表現(本文表示用)。
const SKIP_MARKER_LINE_RE = /^[ \t]*(?:[-*>][ \t]*)?\[SKIP:(?:central|mist)\][^\n]*\n?/gim;

/** テキスト中のすべての省略マーカーを、出現順に返す(同じ platform が複数あればそのまま複数返す)。 */
export function detectPlatformJudgments(text: string): PlatformJudgmentEvent[] {
  if (!text || !/\[SKIP:/i.test(text)) return [];
  const out: PlatformJudgmentEvent[] = [];
  SKIP_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SKIP_MARKER_RE.exec(text))) {
    const platform = m[1].toLowerCase() as Platform;
    out.push({ platform, reason: (m[2] || "").trim() });
  }
  return out;
}

/** 最初に見つかった省略マーカーだけを返す薄いラッパ(1件しか要らない呼び出し元向け)。 */
export function detectPlatformJudgment(text: string): PlatformJudgmentEvent | null {
  return detectPlatformJudgments(text)[0] ?? null;
}

/**
 * ユーザーに見せる回答本文からマーカー行を取り除く(29 Task 5-4)。
 * 判定は SSE の assistant_text 側で済んでいるので、本文には残さない
 * (残すと画面・共有テキスト・印刷レイアウトに `[SKIP:central]` がそのまま出てしまう)。
 */
export function stripPlatformJudgments(text: string): string {
  if (!text || !/\[SKIP:/i.test(text)) return text;
  return text
    .replace(SKIP_MARKER_LINE_RE, "")
    // 行頭でない位置に書かれた場合(文中に混ぜられた場合)の保険。
    .replace(SKIP_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// tool_use の入力から、表示用の短い要約(例: site=Home / site_names=[...])を作る。
export function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    let val: string;
    if (Array.isArray(v)) val = `[${v.slice(0, 3).map(String).join(",")}${v.length > 3 ? "…" : ""}]`;
    else if (typeof v === "object") continue;
    else val = String(v);
    if (val.length > 40) val = val.slice(0, 40) + "…";
    parts.push(`${k}=${val}`);
    if (parts.length >= 2) break;
  }
  return parts.length ? parts.join(", ") : undefined;
}

// ---- 失敗した呼び出しの詳細(08 Task 1) ----
//
// claude CLI の stream-json では、MCP ツールが失敗すると user イベントの tool_result が
// is_error:true になり、content にサーバーが返したエラー本文がそのまま入る。実測例:
//   Tool error: param "query_type" is required for insight_type "sle": …
//   Tool error: resource_type "rftemplates" does not support site scope; …
// 従来はこの本文を捨てて status="error" だけを流していたため、画面では失敗理由が分からなかった。
// ここで本文・ステータス・呼び出し引数を保持し、UI の展開表示へ渡す。

// 履歴(query-history.jsonl)にも載るので、1件が肥大しない程度に頭を切る。
const ERROR_TEXT_MAX = 1200;
const INPUT_JSON_MAX = 600;

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…(以下省略)" : s;
}

// エラー本文から HTTP ステータスらしき 3 桁を1つ拾う。MCP サーバーごとに表記が違う
// ("HTTP 403" / "status: 400" / "Error 429: …")ので代表的な言い回しだけを見る。
// Mist の入力検証エラーのようにコードを含まない本文もあるため、拾えなければ null。
const STATUS_PATTERNS: RegExp[] = [
  /\bHTTP[\s/]?(\d{3})\b/i,
  /\bstatus(?:[ _-]?code)?["']?\s*[:=]\s*["']?(\d{3})\b/i,
  /\b(?:error|failed|response)\s*[:( ]\s*(\d{3})\b/i,
];

export function extractStatusCode(text: string): number | null {
  const t = text || "";
  for (const re of STATUS_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 100 && n <= 599) return n;
    }
  }
  return null;
}

// 呼び出し引数の全文。detail(summarizeInput)は 2 項目まで・オブジェクト値は捨てる要約なので、
// 「params の中身が足りずに失敗した」ようなケースは要約からは読み取れない。失敗時だけ全文を出す。
export function stringifyInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  try {
    return truncate(JSON.stringify(input), INPUT_JSON_MAX);
  } catch {
    return undefined;
  }
}

// tool_result 本文から、ざっくりした「件数」を推定する(JSON 配列/オブジェクトなら要素数)。
export function estimateCount(text: string): number | null {
  const t = (text || "").trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") {
      const r = (parsed as any).result ?? parsed;
      if (Array.isArray(r)) return r.length;
      if (r && typeof r === "object") return Object.keys(r).length;
    }
  } catch {
    /* JSON でなければ件数は不明 */
  }
  return null;
}

// サイト指定から platform を解決し、narrowing 対象(platformsUsed)を決める。
// runInsightAgent(claude CLI 版)・runOllamaAgent(Ollama 版)の両方が使う共通ロジック。
export async function resolveRouting(siteNameOrId?: string): Promise<{
  resolvedPlatform: Platform | null;
  matchedSite: SitePlatformEntry | null;
  platformsUsed: Platform[];
  bothPlatforms: boolean;
}> {
  let resolvedPlatform: Platform | null = null;
  let matchedSite: SitePlatformEntry | null = null;
  if (siteNameOrId && siteNameOrId.trim()) {
    const hit = await resolvePlatformForSite(siteNameOrId);
    if (hit) {
      resolvedPlatform = hit.platform;
      matchedSite = hit.entry;
    }
  }
  const platformsUsed: Platform[] = resolvedPlatform ? [resolvedPlatform] : [...ALL_PLATFORMS];
  return { resolvedPlatform, matchedSite, platformsUsed, bothPlatforms: platformsUsed.length > 1 };
}

/**
 * Insight Agent 共通関数(骨格)。
 *
 * @param query          調査クエリ(自然文)
 * @param siteNameOrId   対象サイト名 or siteId(任意)。指定時は対応表から platform を引き、
 *                       該当プラットフォームの MCP サーバーだけに narrowing する。
 *
 * 呼び出し元(3 箇所):
 *   (a) 対話エンドポイント … api.ts の POST /api/network-investigation/query(本ファイルで仮結線済み)
 *   (b) スケジューラ(定期実行) … 次の指示ファイルで、この関数を cron/launchd から呼ぶ
 *   (c) UI ボタン(手動実行) … 次の指示ファイルで、View のボタン → POST /query 経由でこの関数を呼ぶ
 * いずれも「runInsightAgent() を呼ぶだけ」で同じ narrowing・同じ実行経路になるよう、
 * ロジックはすべてこの関数に閉じている。
 */
export async function runInsightAgent(
  query: string,
  siteNameOrId?: string,
  opts?: {
    /** MCP ツールの呼び出し/完了を1件ずつ受け取る(SSE 見える化用)。省略時は素の実行。 */
    onMcpCall?: (e: McpCallEvent) => void;
    /** モデルが片方のプラットフォームを不要と判断して省略した宣言を受け取る(Task 1)。 */
    onPlatformJudgment?: (e: PlatformJudgmentEvent) => void;
    /** 使用モデル(エイリアス or フルID)。未指定なら CORSTACK_NETINV_MODEL → "sonnet"。 */
    model?: string;
    /** 回答言語(29 Task 4)。UI の表示言語がそのまま渡ってくる。未指定は日本語。 */
    lang?: AgentLang;
    /**
     * 承認済みナレッジから作った「関連する既知の情報」セクション(47)。
     * 呼び出し元(api.ts の runQuery)が注入の有無を決め、本文はナレッジ側が作る。
     * 未指定なら system prompt は従来のままになる。
     */
    knowledge?: string;
  },
): Promise<InsightAgentResult> {
  const q = (query || "").trim();
  if (!q) {
    return {
      answer: "",
      suggestedActions: [],
      isError: true,
      reason: "query が空です",
      resolvedPlatform: null,
      platformsUsed: [],
      mcpServers: [],
      matchedSite: null,
    };
  }

  // 1-2. サイト指定があれば対応表から platform を引き、narrowing 対象を決める。
  const { resolvedPlatform, matchedSite, platformsUsed, bothPlatforms } = await resolveRouting(siteNameOrId);

  // 3. onMcpCall / onPlatformJudgment があれば、stream-json の tool_use/tool_result/text を
  //    「呼び出し(calling)→ 完了(done/error)」の McpCallEvent、および `[判断]` 宣言に変換して流す。
  const pending = new Map<
    string,
    { server: string; platform: Platform | null; tool: string; detail?: string; input?: string }
  >();
  const judged = new Set<Platform>(); // 同じ platform の判断を二重に流さない
  const wantEvents = opts?.onMcpCall || opts?.onPlatformJudgment;
  const onEvent = wantEvents
    ? (e: McpStreamEvent) => {
        if (e.kind === "assistant_text") {
          if (!opts?.onPlatformJudgment) return;
          for (const j of detectPlatformJudgments(e.text)) {
            if (judged.has(j.platform)) continue;
            judged.add(j.platform);
            opts.onPlatformJudgment(j);
          }
          return;
        }
        if (!opts?.onMcpCall) return;
        if (e.kind === "tool_use") {
          const parsed = parseMcpToolName(e.name);
          if (!parsed) return; // MCP 以外のツールは見える化対象外
          const detail = summarizeInput(e.input);
          // 失敗したときに初めて出す全文引数も、この時点で作って持っておく
          // (tool_result 側には input が載らないため)。
          const input = stringifyInput(e.input);
          pending.set(e.id, { server: parsed.server, platform: parsed.platform, tool: parsed.tool, detail, input });
          opts.onMcpCall({
            id: e.id,
            server: parsed.server,
            platform: parsed.platform,
            tool: parsed.tool,
            status: "calling",
            detail,
          });
        } else {
          const p = pending.get(e.toolUseId);
          if (!p) return;
          const errText = e.isError ? (e.text || "").trim() : "";
          opts.onMcpCall({
            id: e.toolUseId,
            server: p.server,
            platform: p.platform,
            tool: p.tool,
            status: e.isError ? "error" : "done",
            detail: p.detail,
            count: estimateCount(e.text),
            // 失敗時のみ詳細を載せる(成功時のレスポンス本文は大きいので流さない)。
            ...(e.isError
              ? {
                  error: errText ? truncate(errText, ERROR_TEXT_MAX) : "エラー本文が空でした",
                  errorStatus: extractStatusCode(errText),
                  input: p.input,
                }
              : {}),
          });
        }
      }
    : undefined;

  // 4. narrowing した MCP config で claude を起動する。両方接続時のみ「両方使う」ルールを足す。
  const res = await runClaudeWithMcp({
    prompt: q,
    platforms: platformsUsed,
    systemPrompt: buildSystemPrompt(bothPlatforms, opts?.lang ?? DEFAULT_AGENT_LANG, opts?.knowledge),
    onEvent,
    model: opts?.model,
    // 「回答は返ったが MCP サーバーに繋がっていなかった」を検出する(09)。
    // narrowing した中で 1 度も呼ばれなかったサーバーだけを直接 probe する。
    checkHealth: true,
  });

  // 回答本文から suggested-actions ブロックと省略マーカーを切り出す(本文からは除去)。
  // エラー時は素通し(失敗理由の本文を加工しない)。
  const { answer, suggestedActions } = res.isError
    ? { answer: res.text, suggestedActions: [] as SuggestedAction[] }
    : extractSuggestedActions(stripPlatformJudgments(res.text));

  return {
    answer,
    suggestedActions,
    isError: res.isError,
    reason: res.reason,
    resolvedPlatform,
    platformsUsed,
    mcpServers: res.mcpServers,
    matchedSite,
    mcpHealth: res.mcpHealth,
  };
}
