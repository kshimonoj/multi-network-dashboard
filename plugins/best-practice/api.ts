/**
 * ベストプラクティス診断(51)— API ルート。
 *
 * エンドポイント:
 *   GET    /status            … 設定 / ルール件数 / 直近の実行一覧
 *   GET    /rules             … ルールカタログ(根拠 URL 込み)
 *   GET    /sites             … 診断できるサイト一覧(?platform=central|mist|both)
 *   POST   /run               … 診断実行(body: { platform, siteId, llm?, lang? })
 *   GET    /runs              … 実行一覧(?limit=)
 *   GET    /runs/:id          … 1 回分の詳細(Finding[] 一式)
 *   DELETE /runs/:id          … 削除
 *   GET    /settings          … 設定
 *   PUT    /settings          … 設定変更
 *
 * **実行はユーザーが「診断実行」を押したときだけ**(51 の確定事項)。
 * スケジュール実行の口はこのプラグインには作らない。
 *
 * 実行は 1 サイトあたり show コマンド 4〜5 本 + AP 台数分の詳細取得で 1〜2 分かかる。
 * HTTP を待たせ続けないよう、POST /run は runId を即返し、結果はポーリングで取りに来る形にする。
 */

import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { McpToolSession } from "../network-investigation/ollama-mcp-client.js";
import {
  collectCentralSite,
  listCentralSites,
  openCentralSession,
  type CentralSiteRef,
} from "./collect-central.js";
import {
  collectMistSite,
  listMistSites,
  openMistSession,
  resolveMistOrgId,
  type MistSiteRef,
} from "./collect-mist.js";
import { evaluateCentral, evaluateMist, summarize } from "./evaluate.js";
import { runLlmFindings, type LlmLang } from "./llm.js";
import { RULES, ruleCounts } from "./rules.js";
import {
  deleteRun,
  ensureDirs,
  getSettings,
  isValidRunId,
  listRuns,
  loadIndex,
  loadSettings,
  readRun,
  saveSettings,
  writeRun,
} from "./store.js";
import type { DiagnosisRun, Finding, SiteSnapshot } from "./types.js";

export const router = Router();

export async function initBestPractice(): Promise<void> {
  await ensureDirs();
  await loadSettings();
  await loadIndex();
  const c = ruleCounts();
  console.log(
    `[best-practice] ルール ${c.total} 件(セキュリティ ${c.security} / RF ${c.rf}、` +
      `機械判定 ${c.mechanical} / LLM 所見 ${c.llm})を読み込みました。実行は手動トリガーのみ`,
  );
}

// ---- 実行中の管理(同じサイトを二重に叩かない)----

interface InFlight {
  runId: string;
  platform: "central" | "mist";
  siteId: string;
  startedAt: string;
}

const inFlight = new Map<string, InFlight>(); // key: `${platform}:${siteId}`

function flightKey(platform: string, siteId: string): string {
  return `${platform}:${siteId}`;
}

// ---- サイト一覧(短時間キャッシュ)----
// サイト一覧は MCP を数回叩くので、画面の再描画ごとに取り直さない。

interface SiteEntry {
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  apCount: number;
}

let siteCache: { at: number; sites: SiteEntry[] } | null = null;
const SITE_CACHE_MS = 60_000;

async function withSession<T>(
  platform: "central" | "mist",
  fn: (session: McpToolSession) => Promise<T>,
): Promise<T> {
  const session = platform === "central" ? await openCentralSession() : await openMistSession();
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function loadSites(platform: "central" | "mist" | "both"): Promise<SiteEntry[]> {
  const wanted: Array<"central" | "mist"> =
    platform === "both" ? ["central", "mist"] : [platform];
  const out: SiteEntry[] = [];

  for (const p of wanted) {
    try {
      if (p === "central") {
        const sites = await withSession("central", (s) => listCentralSites(s));
        out.push(...sites.map((s) => ({ platform: "central" as const, ...s })));
      } else {
        const sites = await withSession("mist", async (s) => {
          const orgId = await resolveMistOrgId(s);
          if (!orgId) return [] as MistSiteRef[];
          return await listMistSites(s, orgId);
        });
        out.push(
          ...sites.map((s) => ({
            platform: "mist" as const,
            siteId: s.siteId,
            siteName: s.siteName,
            apCount: s.apCount,
          })),
        );
      }
    } catch (err) {
      console.error(
        `[best-practice] ${p} のサイト一覧を取得できませんでした:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

// ---- 診断の実行 ----

/**
 * 1 サイト分の診断を最後まで走らせて保存する。
 * 失敗しても throw せず、error 付きの DiagnosisRun を保存する
 * (「押したのに何も残らない」状態を作らない)。
 */
async function executeRun(args: {
  runId: string;
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  llm: boolean;
  lang: LlmLang;
}): Promise<void> {
  const { runId, platform, siteId, llm, lang } = args;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const settings = getSettings();

  let snapshot: SiteSnapshot | null = null;
  let findings: Finding[] = [];
  let llmModel: string | null = null;
  let error: string | null = null;
  let siteName = args.siteName;

  try {
    snapshot = await withSession(platform, async (session) => {
      if (platform === "central") {
        const sites = await listCentralSites(session);
        const ref: CentralSiteRef = sites.find((s) => s.siteId === siteId) ?? {
          siteId,
          siteName: siteName || siteId,
          apCount: 0,
        };
        siteName = ref.siteName;
        return await collectCentralSite(session, ref);
      }
      const orgId = await resolveMistOrgId(session);
      if (!orgId) throw new Error("Mist の org_id を解決できませんでした");
      const sites = await listMistSites(session, orgId);
      const ref: MistSiteRef = sites.find((s) => s.siteId === siteId) ?? {
        siteId,
        siteName: siteName || siteId,
        rfTemplateId: null,
        apCount: 0,
      };
      siteName = ref.siteName;
      return await collectMistSite(session, orgId, ref);
    });

    const collectedAt = new Date().toISOString();
    findings =
      snapshot.platform === "central"
        ? evaluateCentral(snapshot, collectedAt, settings.disabledRuleIds)
        : evaluateMist(snapshot, collectedAt, settings.disabledRuleIds);

    if (llm) {
      const outcome = await runLlmFindings(snapshot, findings, {
        model: settings.llmModel,
        lang,
        collectedAt,
      });
      llmModel = outcome.model;
      findings = [
        ...findings,
        ...outcome.findings.filter((f) => !settings.disabledRuleIds.includes(f.ruleId)),
      ];
      if (outcome.error) {
        console.warn(`[best-practice] LLM 所見に失敗しました(機械判定は保存します): ${outcome.error}`);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[best-practice] 診断に失敗しました(${platform}/${siteId}):`, error);
  }

  const steps = snapshot
    ? snapshot.platform === "central"
      ? [...snapshot.steps, ...snapshot.representatives.flatMap((r) => r.steps)]
      : snapshot.steps
    : [];

  const run: DiagnosisRun = {
    id: runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    platform,
    siteId,
    siteName,
    trigger: "manual",
    llmEnabled: llm,
    llmModel,
    findings,
    summary: summarize(findings),
    steps,
    sampledDeviceIds:
      snapshot?.platform === "central" ? snapshot.representatives.map((r) => r.ap.serial) : [],
    error,
  };

  await writeRun(run);
  console.log(
    `[best-practice] 診断完了: ${platform}/${siteName} ${run.durationMs}ms ` +
      `pass=${run.summary.pass} warn=${run.summary.warn} fail=${run.summary.fail} ` +
      `unknown=${run.summary.unknown} n/a=${run.summary.not_applicable}` +
      (run.summary.legalReview ? ` legalReview=${run.summary.legalReview}` : ""),
  );
}

/** 動作確認・他プラグインからの再利用のために同期版も出す(HTTP は使わない) */
export async function runDiagnosis(args: {
  platform: "central" | "mist";
  siteId: string;
  siteName?: string;
  llm?: boolean;
  lang?: LlmLang;
}): Promise<DiagnosisRun | null> {
  const runId = randomUUID();
  await executeRun({
    runId,
    platform: args.platform,
    siteId: args.siteId,
    siteName: args.siteName ?? args.siteId,
    llm: args.llm ?? getSettings().llmEnabled,
    lang: args.lang === "en" ? "en" : "ja",
  });
  return await readRun(runId);
}

// ---- ルート ----

function platformOf(v: unknown): "central" | "mist" | null {
  const s = String(v ?? "").toLowerCase();
  return s === "central" || s === "mist" ? s : null;
}

router.get("/status", (_req, res) => {
  const s = getSettings();
  res.json({
    ok: true,
    settings: s,
    rules: ruleCounts(),
    inFlight: [...inFlight.values()],
    runs: listRuns(20),
  });
});

router.get("/rules", (_req, res) => {
  res.json({ ok: true, rules: RULES, counts: ruleCounts() });
});

router.get("/sites", async (req, res) => {
  const raw = String(req.query.platform ?? "both").toLowerCase();
  const platform = raw === "central" || raw === "mist" ? raw : "both";
  const fresh = String(req.query.refresh ?? "") === "1";

  if (!fresh && siteCache && Date.now() - siteCache.at < SITE_CACHE_MS) {
    const sites = siteCache.sites.filter((s) => platform === "both" || s.platform === platform);
    res.json({ ok: true, sites, cached: true });
    return;
  }

  try {
    const sites = await loadSites("both");
    siteCache = { at: Date.now(), sites };
    res.json({
      ok: true,
      sites: sites.filter((s) => platform === "both" || s.platform === platform),
      cached: false,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/run", async (req, res) => {
  const platform = platformOf(req.body?.platform);
  const siteId = String(req.body?.siteId ?? "").trim();
  if (!platform || !siteId) {
    res.status(400).json({ ok: false, error: "platform(central|mist)と siteId は必須です" });
    return;
  }

  const key = flightKey(platform, siteId);
  const running = inFlight.get(key);
  if (running) {
    res.status(409).json({ ok: false, error: "同じサイトの診断が実行中です", running });
    return;
  }

  const runId = randomUUID();
  const entry: InFlight = { runId, platform, siteId, startedAt: new Date().toISOString() };
  inFlight.set(key, entry);

  const llm = typeof req.body?.llm === "boolean" ? req.body.llm : getSettings().llmEnabled;
  const lang: LlmLang = req.body?.lang === "en" ? "en" : "ja";
  const siteName = String(req.body?.siteName ?? siteId);

  // 実行は数十秒〜数分かかるので、runId を先に返してバックグラウンドで走らせる。
  res.json({ ok: true, runId, platform, siteId, llm });

  void executeRun({ runId, platform, siteId, siteName, llm, lang }).finally(() => {
    inFlight.delete(key);
  });
});

router.get("/runs", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  res.json({ ok: true, runs: listRuns(Number.isFinite(limit) ? limit : 50) });
});

router.get("/runs/:id", async (req, res) => {
  const id = req.params.id;
  if (!isValidRunId(id)) {
    res.status(400).json({ ok: false, error: "不正な runId です" });
    return;
  }
  const run = await readRun(id);
  if (!run) {
    // まだ書き込まれていない = 実行中の可能性がある
    const running = [...inFlight.values()].find((f) => f.runId === id);
    if (running) {
      res.status(202).json({ ok: true, status: "running", running });
      return;
    }
    res.status(404).json({ ok: false, error: "見つかりません" });
    return;
  }
  res.json({ ok: true, run });
});

router.delete("/runs/:id", async (req, res) => {
  const ok = await deleteRun(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

router.get("/settings", (_req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

router.put("/settings", async (req, res) => {
  const next = await saveSettings(req.body);
  res.json({ ok: true, settings: next });
});
