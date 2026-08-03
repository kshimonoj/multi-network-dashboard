// 日次レポート(41)— 生成の入口と、起動時の後追い生成(Task 3-3)。
//
// 収集(collect.ts)→ 分析(analyze.ts)→ 保存(store.ts)を 1 本にまとめたもの。
// 呼び出し元は 3 箇所:
//   - 定期実行(schedule.ts / 既定 毎日 9:00 に前日分)
//   - 手動トリガー(api.ts の POST /daily/generate)
//   - 起動時の後追い(この下の catchUpMissing)
//
// LLM を起こすので、同時に複数走らせない(直列キュー)。既存の enrich.ts と同じ考え方。

import { collectDay, hasAnyData } from "./collect.js";
import { analyzeDay, type PastIssue } from "./analyze.js";
import { triggerAutoInvestigations } from "./auto-investigate.js";
import { refreshPeriodsForDate } from "./period-generate.js";
import {
  getSettings,
  hasDaily,
  readDaily,
  readRecentIssueHistory,
  writeDaily,
} from "./store.js";
import { REPORT_SCHEMA_VERSION, type DailyReport } from "./types.js";
import { REPORT_TZ, addDays, todayKey } from "./time.js";

/** 再発性の判定に渡す過去日数。 */
const HISTORY_DAYS = Math.max(1, Number(process.env.REPORTS_HISTORY_DAYS ?? 14));

export type GenerateTrigger = "schedule" | "manual" | "catchup";

export interface GenerateOutcome {
  date: string;
  status: "generated" | "skipped-exists" | "skipped-no-data" | "failed";
  reason: string | null;
  report: DailyReport | null;
  durationMs: number;
}

// LLM を同時に何本も起こさない。生成要求は直列に流す。
let chain: Promise<unknown> = Promise.resolve();
let running: string | null = null;

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => undefined);
  return next;
}

/** 生成中の対象日(重複要求の可視化用)。 */
export function runningDate(): string | null {
  return running;
}

/**
 * 対象日の日次レポートを生成して保存する。
 *
 * @param dateKey  対象日(ローカル TZ の暦日)
 * @param trigger  発生源。レポートに generatedBy として残る
 * @param opts.force        既存ファイルがあっても作り直す
 * @param opts.requireData  4 ソースすべてが空なら作らない(後追い生成で使う)
 */
export async function generateDaily(
  dateKey: string,
  trigger: GenerateTrigger,
  opts: { force?: boolean; requireData?: boolean } = {},
): Promise<GenerateOutcome> {
  return serialize(async () => {
    const startedAt = Date.now();
    running = dateKey;
    try {
      if (!opts.force && (await hasDaily(dateKey))) {
        const existing = await readDaily(dateKey);
        // 当日分を途中で生成した「未完成」レポートは、定期実行・後追いのときだけ作り直す。
        // (手動で覗いた当日分が、翌朝 9:00 の正式な生成を塞いでしまうのを防ぐ。)
        const stalePartial = existing?.partial === true && trigger !== "manual";
        if (!stalePartial) {
          return {
            date: dateKey,
            status: "skipped-exists" as const,
            reason: "既に生成済みです(force=true で作り直せます)",
            report: existing,
            durationMs: Date.now() - startedAt,
          };
        }
        console.log(`[reports] ${dateKey}: 当日途中に作られた未完成レポートを作り直します`);
      }

      const { window, data } = await collectDay(dateKey);

      if (opts.requireData && !hasAnyData(data)) {
        console.log(`[reports] ${dateKey}: 収集できたデータが 1 件も無いため生成をスキップしました`);
        return {
          date: dateKey,
          status: "skipped-no-data" as const,
          reason: "この日のデータが 4 ソースとも空でした(アプリ稼働前の可能性)",
          report: null,
          durationMs: Date.now() - startedAt,
        };
      }

      const settings = getSettings();
      const pastRaw = await readRecentIssueHistory(dateKey, HISTORY_DAYS);
      const past: PastIssue[] = pastRaw.map((p) => ({
        date: p.date,
        key: p.key,
        name: p.name,
        device: p.device,
        site: p.site,
        severity: p.severity,
      }));

      console.log(
        `[reports] ${dateKey} のレポート生成を開始(${trigger}): ` +
          `サンプル ${data.overview.sampleCount} / Webhook ${data.webhook.total} 件 / ` +
          `Audit ${data.streaming.auditTrail.total} 件 / 調査 ${data.investigations.total} 件 / ` +
          `過去問題 ${past.length} 件`,
      );

      const analyzed = await analyzeDay({
        dateKey,
        data,
        past,
        model: settings.model,
        lang: settings.lang,
      });

      const generatedAt = new Date();
      const report: DailyReport = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        date: dateKey,
        timeZone: REPORT_TZ,
        window: { startIso: window.startIso, endIso: window.endIso },
        generatedAt: generatedAt.toISOString(),
        generatedBy: trigger,
        partial: generatedAt.getTime() < window.endMs,
        lang: settings.lang,
        llm: {
          status: analyzed.analysis.status,
          model: analyzed.model,
          durationMs: analyzed.durationMs,
          attempts: analyzed.attempts,
          error: analyzed.error,
        },
        data,
        analysis: analyzed.analysis,
      };

      const file = await writeDaily(report);
      console.log(
        `[reports] ${dateKey} のレポートを保存しました: ${file} ` +
          `(分析=${analyzed.analysis.status} 起きたこと ${analyzed.analysis.highlights.length} 件 / ` +
          `問題 ${analyzed.analysis.issues.length} 件 / ${Math.round(analyzed.durationMs / 1000)}s)`,
      );

      // 44: 重大かつ新規/継続の問題に、MCP 込みの本格調査を先回りで仕掛ける。
      // 実行はバックグラウンド(auto-investigate.ts 側の直列キュー)なので生成は待たない。
      // 失敗してもレポート生成そのものは成立させる。
      await triggerAutoInvestigations(report).catch((err) =>
        console.error(`[reports] ${dateKey} の自動事前調査の仕掛けに失敗:`, err),
      );

      // 45: この日を含む週次 / 月次を作り直す。集計だけ(LLM も外部 API も無し)で数十 ms なので、
      // 翌朝の定期実行を待たずにここで追従させる。失敗しても日次レポートは成立させる。
      await refreshPeriodsForDate(dateKey).catch((err) =>
        console.error(`[reports] ${dateKey} を含む週次 / 月次の追従生成に失敗:`, err),
      );

      return {
        date: dateKey,
        status: "generated" as const,
        reason: null,
        report,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[reports] ${dateKey} のレポート生成に失敗:`, err);
      return {
        date: dateKey,
        status: "failed" as const,
        reason,
        report: null,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      running = null;
    }
  });
}

// ---- 起動時の後追い生成(Task 3-3)----

let lastCatchUp: { ranAt: string; checked: string[]; results: Array<{ date: string; status: string }> } | null = null;

export function lastCatchUpInfo(): typeof lastCatchUp {
  return lastCatchUp;
}

/**
 * 直近 catchUpDays 日ぶんの日次レポートが欠けていないか確認し、欠けていれば作る。
 *
 * - 対象は「昨日」以前。当日は 1 日が終わっていないので作らない。
 * - 4 ソースとも空の日(アプリが動いていなかった日)は作らない(requireData)。
 *   MacBook が長期間落ちていた場合に、空のレポートと LLM 呼び出しが量産されるのを防ぐ。
 * - 直列に 1 日ずつ処理する(generateDaily 自体が直列キュー)。
 * - **古い日から順に** 作る。再発性(recurrence)の判定は「その日より前の日次レポート」を
 *   照合するので、新しい日から作ると先に作った日の過去照合が常に空になってしまう。
 */
export async function catchUpMissing(): Promise<NonNullable<typeof lastCatchUp>> {
  const { catchUpDays } = getSettings();
  const today = todayKey();
  const checked: string[] = [];
  const results: Array<{ date: string; status: string }> = [];

  for (let i = catchUpDays; i >= 1; i--) {
    const date = addDays(today, -i);
    checked.push(date);
    const existing = await readDaily(date);
    // 当日途中に作られた未完成レポートは「欠けている」のと同じ扱いで作り直す。
    if (existing && existing.partial !== true) {
      results.push({ date, status: "exists" });
      continue;
    }
    const r = await generateDaily(date, "catchup", { requireData: true });
    results.push({ date, status: r.status });
  }

  const generated = results.filter((r) => r.status === "generated").length;
  const skipped = results.filter((r) => r.status === "skipped-no-data").length;
  console.log(
    `[reports] 起動時の後追い確認が完了: 直近 ${catchUpDays} 日を確認 → ` +
      `生成 ${generated} 件 / データ無しでスキップ ${skipped} 件 / 既存 ${results.filter((r) => r.status === "exists").length} 件`,
  );

  lastCatchUp = { ranAt: new Date().toISOString(), checked, results };
  return lastCatchUp;
}
