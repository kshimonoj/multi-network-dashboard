// セッション(「続けて調べる」で繋がった一連の実行)を扱う純関数(04)。
//
// 調査(instructions/04_findings.md)の通り、各ターンは独立した claude 実行で会話文脈は
// 引き継いでいない。ここで言う「セッション」は会話の連続ではなく
// 「どの回答から派生したか」= ユーザーの調査の流れ のグルーピングである。
//
// 後方互換の分岐はこのファイルの sessionKey() 1 箇所に閉じる。
// sessionId を持たない旧履歴は「自分1件だけのセッション」として扱う
// (サーバー側 api.ts の sessionKey() と同じ規則)。

import type { TFunc } from "../../../src/i18n";
import type {
  HistoryRecord,
  HistoryToolCall,
  KnowledgeRef,
  McpCall,
  McpHealth,
  Platform,
  PlatformJudgment,
  SuggestedAction,
} from "./types";

export function sessionKey(rec: HistoryRecord): string {
  return rec.sessionId && rec.sessionId.trim() ? rec.sessionId : rec.id;
}

export type TurnSource = "manual" | "scheduled" | "auto";

/**
 * 実行元のラベル(タイムライン・ターン見出しのタグ)。
 * "auto" は Webhook ログの重大アラートに対する自動事前調査(17 Task 4)。
 * 人が実行したものと区別が付くようにする。
 * 33: 定数マップから t() 引きに変えた(未知の source は "manual" のラベルへ倒す)。
 */
export function sourceLabel(t: TFunc, source: string): string {
  const key = source === "scheduled" || source === "auto" ? source : "manual";
  return t(`networkInvestigation.source.${key}`);
}

/**
 * 曜日ラベル(0=日曜 … 6=土曜。cron / launchd と同じ番号体系)。
 * 33 L-5: 以前は Timeline.tsx と ScheduleEditor.tsx が別々に
 * `["日","月",…]` を持ち、表示側で `${w}曜` と組み立てていた。日本語 1 文字前提の
 * 組み立てだったので、辞書に完全な曜日名("日曜" / "Sunday")を置いてここに集約する。
 * 範囲外の値は月曜へ倒す(ScheduleConfig の既定値と同じ)。
 */
export function weekdayLabel(t: TFunc, dayOfWeek: number): string {
  const d = Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6 ? dayOfWeek : 1;
  return t(`networkInvestigation.schedule.weekday.${d}`);
}

// 1ターン(1回のクエリと回答)の表示データ。履歴レコードからも、実行中の RunState からも作れる。
// Turn.tsx / SessionShare.tsx は常にこの形だけを見る。
export interface SessionTurn {
  id: string; // runId
  ts: string;
  query: string;
  site: string | null;
  model: string | null;
  source: "manual" | "scheduled" | "auto";
  platformsUsed: Platform[];
  mcpServers: string[];
  calls: HistoryToolCall[];
  judgments: PlatformJudgment[];
  answer: string;
  isError: boolean;
  reason: string | null;
  suggestedActions: SuggestedAction[];
  /** MCP サーバーの接続健全性(09)。level!=="ok" ならターンに警告バナーを出す。 */
  mcpHealth?: McpHealth;
  /** この実行の所要時間(ミリ秒)(26)。旧履歴には無いので null。 */
  durationMs: number | null;
  /** system prompt に注入された承認済みナレッジ(47)。注入が無ければ空配列。 */
  knowledgeRefs: KnowledgeRef[];
  /** まだ query-history.jsonl に載っていない(実行直後の)ターンか */
  live?: boolean;
}

// 所要時間の表示用整形(26)。旧履歴等で記録が無い場合は「—」にする。
export function formatDuration(t: TFunc, ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return t("networkInvestigation.duration.none");
  if (ms < 1000) return t("networkInvestigation.duration.ms", { n: ms });
  return t("networkInvestigation.duration.sec", { n: (ms / 1000).toFixed(1) });
}

export function turnFromRecord(rec: HistoryRecord): SessionTurn {
  return {
    id: rec.id,
    ts: rec.ts,
    query: rec.query,
    site: rec.site,
    model: rec.model ?? null,
    source: rec.source,
    platformsUsed: rec.platformsUsed ?? [],
    mcpServers: rec.mcpServers ?? [],
    calls: rec.calls ?? [],
    judgments: rec.judgments ?? [],
    // 回答全文が無い旧履歴は抜粋にフォールバックする(HistoryDetail 時代と同じ)。
    answer: rec.answer ?? rec.answerExcerpt ?? "",
    isError: rec.isError,
    reason: rec.reason ?? null,
    suggestedActions: rec.suggestedActions ?? [],
    mcpHealth: rec.mcpHealth,
    durationMs: rec.durationMs ?? null,
    knowledgeRefs: rec.knowledgeRefs ?? [],
  };
}

// 実行中/実行直後の run(SSE で積み上がった状態)を、履歴と同じ形のターンにする。
export function turnFromRun(
  id: string,
  run: {
    query: string | null;
    site: string | null;
    ts: string | null;
    model: string | null;
    calls: McpCall[];
    judgments: PlatformJudgment[];
    answer: { text: string; isError: boolean; reason: string | null } | null;
    platformsUsed: Platform[];
    suggestedActions: SuggestedAction[];
    mcpHealth: McpHealth | null;
    durationMs?: number | null;
    knowledgeRefs?: KnowledgeRef[];
  },
): SessionTurn {
  return {
    id,
    ts: run.ts ?? new Date().toISOString(),
    query: run.query ?? "",
    site: run.site,
    model: run.model,
    source: "manual",
    platformsUsed: run.platformsUsed,
    // 実行中は mcpServers の確定値が無いので、呼び出したサーバー名から重複を除いて作る。
    mcpServers: Array.from(new Set(run.calls.map((c) => c.server))),
    calls: run.calls.map((c) => ({
      server: c.server,
      platform: c.platform,
      tool: c.tool,
      status: c.status,
      detail: c.detail,
      count: c.count,
      // 失敗詳細(08 Task 1)。実行直後のターン表示でも展開できるように引き継ぐ。
      error: c.error,
      errorStatus: c.errorStatus,
      input: c.input,
    })),
    judgments: run.judgments,
    answer: run.answer?.text ?? "",
    isError: run.answer?.isError ?? false,
    reason: run.answer?.reason ?? null,
    suggestedActions: run.suggestedActions,
    mcpHealth: run.mcpHealth ?? undefined,
    durationMs: run.durationMs ?? null,
    knowledgeRefs: run.knowledgeRefs ?? [],
    live: true,
  };
}

export function sortTurnsAsc(turns: SessionTurn[]): SessionTurn[] {
  return [...turns].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// ---- タイムライン用のセッション単位グルーピング ----

export interface SessionGroup {
  key: string;
  records: HistoryRecord[]; // ts 昇順(古い順 = 調査の流れの順)
  first: HistoryRecord; // 最初のクエリ(スレッドの見出しに使う)
  last: HistoryRecord; // 最後の回答(抜粋に使う)
  latestTs: string;
  hasError: boolean;
  mcpServers: string[]; // セッション全体で使った MCP サーバー(重複除去)
  /** セッション内で最も強い MCP 接続警告(09)。警告が無ければ "ok"。 */
  mcpHealthLevel: "ok" | "warn" | "unreachable";
}

// 履歴(新しい順)をセッションごとにまとめ、最終実行の新しい順に並べて返す。
export function groupSessions(history: HistoryRecord[]): SessionGroup[] {
  const byKey = new Map<string, HistoryRecord[]>();
  for (const rec of history) {
    const key = sessionKey(rec);
    const arr = byKey.get(key);
    if (arr) arr.push(rec);
    else byKey.set(key, [rec]);
  }
  const groups: SessionGroup[] = [];
  for (const [key, recs] of byKey) {
    const sorted = [...recs].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const servers = new Set<string>();
    for (const r of sorted) for (const s of r.mcpServers ?? []) servers.add(s);
    groups.push({
      key,
      records: sorted,
      first: sorted[0],
      last: sorted[sorted.length - 1],
      latestTs: sorted[sorted.length - 1].ts,
      hasError: sorted.some((r) => r.isError),
      mcpServers: [...servers],
      mcpHealthLevel: sorted.some((r) => r.mcpHealth?.level === "unreachable")
        ? "unreachable"
        : sorted.some((r) => r.mcpHealth?.level === "warn")
          ? "warn"
          : "ok",
    });
  }
  groups.sort((a, b) => (a.latestTs < b.latestTs ? 1 : a.latestTs > b.latestTs ? -1 : 0));
  return groups;
}

// 新しいセッションIDを採番する(初回クエリ時)。crypto.randomUUID が無い環境
// (古いブラウザ・http でのアクセス)でも動くようフォールバックを置く。
// サーバー側の検証 /^[A-Za-z0-9_-]{8,64}$/ を満たす形にする。
export function newSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `s-${Date.now().toString(36)}-${rand()}${rand()}`;
}
