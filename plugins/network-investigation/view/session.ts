// セッション(「続けて調べる」で繋がった一連の実行)を扱う純関数(04)。
//
// 調査(instructions/04_findings.md)の通り、各ターンは独立した claude 実行で会話文脈は
// 引き継いでいない。ここで言う「セッション」は会話の連続ではなく
// 「どの回答から派生したか」= ユーザーの調査の流れ のグルーピングである。
//
// 後方互換の分岐はこのファイルの sessionKey() 1 箇所に閉じる。
// sessionId を持たない旧履歴は「自分1件だけのセッション」として扱う
// (サーバー側 api.ts の sessionKey() と同じ規則)。

import type {
  HistoryRecord,
  HistoryToolCall,
  McpCall,
  McpHealth,
  Platform,
  PlatformJudgment,
  SuggestedAction,
} from "./types";

export function sessionKey(rec: HistoryRecord): string {
  return rec.sessionId && rec.sessionId.trim() ? rec.sessionId : rec.id;
}

/**
 * 実行元のラベル(タイムライン・ターン見出しのタグ)。
 * "auto" は Webhook ログの重大アラートに対する自動事前調査(17 Task 4)。
 * 人が実行したものと区別が付くようにする。
 */
export const SOURCE_LABEL: Record<"manual" | "scheduled" | "auto", string> = {
  manual: "手動",
  scheduled: "定期",
  auto: "自動調査",
};

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
  /** まだ query-history.jsonl に載っていない(実行直後の)ターンか */
  live?: boolean;
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
