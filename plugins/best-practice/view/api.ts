// ベストプラクティス診断 View — /api/best-practice/* への fetch ラッパ。
//
// 実行(POST /run)は runId を即返し、結果は GET /runs/:id をポーリングして取りに行く
// (サーバ側コメント: 1 サイトの診断は 8〜10 秒程度かかる)。

import { getLang } from "../../../src/i18n";
import type {
  DiagnosisRun,
  RulesResponse,
  RunDoneResponse,
  RunPendingResponse,
  RunStartResponse,
  RunsListResponse,
  SitesResponse,
} from "./types";

const BASE = "/api/best-practice";

async function json<T>(res: Response): Promise<T> {
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error((parsed as { error?: string })?.error ?? `HTTP ${res.status}`);
  return parsed as T;
}

/** ルールカタログ(根拠 URL・重要度・カテゴリ込み)。滅多に変わらないので毎回取っても軽い。 */
export async function fetchRules(): Promise<RulesResponse> {
  return json<RulesResponse>(await fetch(`${BASE}/rules`));
}

export async function fetchSites(refresh = false): Promise<SitesResponse> {
  const q = refresh ? "?platform=both&refresh=1" : "?platform=both";
  return json<SitesResponse>(await fetch(`${BASE}/sites${q}`));
}

export async function startRun(args: {
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  llm: boolean;
}): Promise<RunStartResponse> {
  return json<RunStartResponse>(
    await fetch(`${BASE}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, lang: getLang() }),
    }),
  );
}

export type RunPollResult =
  | { state: "done"; run: DiagnosisRun }
  | { state: "running" }
  | { state: "not_found" };

/** 202=実行中 / 200=完了 / 404=未実行(あるいは既に削除済み) を区別する。 */
export async function pollRun(runId: string): Promise<RunPollResult> {
  const res = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) return { state: "not_found" };
  const body = (await json<RunDoneResponse | RunPendingResponse>(res)) as
    | RunDoneResponse
    | RunPendingResponse;
  if ("status" in body && body.status === "running") return { state: "running" };
  return { state: "done", run: (body as RunDoneResponse).run };
}

/** 過去の実行一覧(直近から)。サイト選択時に「最後の結果」を出すために使う。 */
export async function fetchRuns(limit = 50): Promise<RunsListResponse> {
  return json<RunsListResponse>(await fetch(`${BASE}/runs?limit=${limit}`));
}
