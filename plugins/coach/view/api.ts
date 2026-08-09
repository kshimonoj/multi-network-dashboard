// Coach View(65)— /api/coach/* への fetch ラッパ。
//
// サーバは機械可読な `code` を返す(文章は画面側の辞書で作る)。code を Error に載せて運ぶ。

import { getLang } from "../../../src/i18n";
import type {
  ChatResponse,
  CoachSessionDetail,
  CoachSessionSummary,
  CoachStatus,
  QuizAnswerResponse,
  QuizResponse,
  TurnIntent,
  WeaknessResponse,
} from "./types";

const BASE = "/api/coach";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(`HTTP ${res.status}: ${body.slice(0, 300)}`, null);
  }
  if (!res.ok) {
    const p = parsed as { error?: string; code?: string };
    throw new ApiError(p?.error ?? `HTTP ${res.status}`, p?.code ?? null);
  }
  return parsed as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchStatus(): Promise<CoachStatus> {
  return json<CoachStatus>(await fetch(`${BASE}/status`));
}

export async function fetchWeakness(): Promise<WeaknessResponse> {
  return json<WeaknessResponse>(await fetch(`${BASE}/weakness`));
}

/**
 * 壁打ち 1 往復。表示言語をそのまま Coach の回答言語にする
 * (ネットワーク調査タブの runQuery と同じ経路。CLAUDE.md「Insight Agent の回答言語」)。
 */
export async function sendChat(opts: {
  sessionId: string;
  question: string;
  intent: TurnIntent;
  incidentMode: boolean;
}): Promise<ChatResponse> {
  return json<ChatResponse>(await fetch(`${BASE}/chat`, post({ ...opts, lang: getLang() })));
}

// ---- 壁打ち履歴の閲覧(70 番)----
//
// 一覧は要約だけを引き、行を開いたときに詳細(全文)を 1 件だけ引く。
// **lang は送らない。** 記録された本文は実行時の記録で、後から別言語で開いても
// 「その実行が何を答えたか」は変わらない(CLAUDE.md)。

export async function fetchSessions(limit = 50): Promise<{ sessions: CoachSessionSummary[] }> {
  return json<{ sessions: CoachSessionSummary[] }>(await fetch(`${BASE}/sessions?limit=${limit}`));
}

export async function fetchSession(sessionId: string): Promise<{ session: CoachSessionDetail }> {
  return json<{ session: CoachSessionDetail }>(
    await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`),
  );
}

export async function startQuiz(sessionId: string): Promise<QuizResponse> {
  return json<QuizResponse>(await fetch(`${BASE}/quiz`, post({ sessionId, lang: getLang() })));
}

export async function answerQuiz(opts: {
  sessionId: string;
  answer: string;
  reveal: boolean;
}): Promise<QuizAnswerResponse> {
  return json<QuizAnswerResponse>(await fetch(`${BASE}/quiz/answer`, post({ ...opts, lang: getLang() })));
}
