// ベストプラクティス診断タブ(52)。
//
// サイトを選んで「診断実行」を押すと、サーバ側(plugins/best-practice/api.ts)が
// 代表 AP 1 台をサンプリングして機械判定 + (任意で)AI 所見を実行する(8〜10 秒程度)。
// POST /run は runId を即返すだけなので、ここでは GET /runs/:id を数秒おきにポーリングする。
//
// サイト一覧は Global Overview の SiteFocusRequest 機構(サイト詳細ページへのジャンプ用)とは
// 目的が異なり、こちら専用の GET /sites がプラットフォーム横断で必要十分な形
// (platform/siteId/siteName/apCount)を既に返すため、そちらをそのまま使う
// (Global Overview 側のスナップショット取得・ポーリング設定には乗らない)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime, useT } from "../../../src/i18n";
import type { TFunc } from "../../../src/i18n";
import { fetchRules, fetchRuns, fetchSites, pollRun, startRun } from "./api";
import { findingText, ruleDesc, ruleTitle } from "./findingText";
import { RuleReference } from "./RuleReference";
import {
  CATEGORY_ORDER,
  SEVERITY_ORDER,
  STATUS_ORDER,
  type BestPracticeRule,
  type CheckCategory,
  type DiagnosisRun,
  type Finding,
  type FindingStatus,
  type SiteEntry,
} from "./types";
import "../../global-overview/view/styles.css";
import "./styles.css";

type BpView = "diagnose" | "reference";

const POLL_MS = 2000;
// 収集は 1〜2 分かかることがある(api.ts のコメント)。安全側に長めの上限を取る。
const MAX_POLL_ATTEMPTS = 150;

interface Props {
  active: boolean;
  /**
   * Coach タブの根拠リンク(65)から渡される「開きたいルールの ID」。
   * highlightRuleId の仕組み自体は 53 番からあり、ここでは外から渡せるようにしただけ。
   * 受け取ったらルール一覧(リファレンス)へ切り替えてハイライトする。
   */
  pendingRuleFocus?: string | null;
  onConsumePendingRuleFocus?: () => void;
}

function siteKey(platform: "central" | "mist", siteId: string): string {
  return `${platform}:${siteId}`;
}

function categoryOf(ruleId: string): CheckCategory {
  return ruleId.startsWith("SEC-") ? "security" : "rf";
}

function worstStatus(statuses: FindingStatus[]): FindingStatus {
  for (const s of STATUS_ORDER) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

interface RuleGroup {
  ruleId: string;
  rule: BestPracticeRule | undefined;
  findings: Finding[];
  worst: FindingStatus;
}

function groupFindings(
  findings: Finding[],
  rulesById: Map<string, BestPracticeRule>,
): Map<CheckCategory, RuleGroup[]> {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byRule.get(f.ruleId);
    if (arr) arr.push(f);
    else byRule.set(f.ruleId, [f]);
  }

  const byCategory = new Map<CheckCategory, RuleGroup[]>();
  for (const [ruleId, list] of byRule) {
    const group: RuleGroup = {
      ruleId,
      rule: rulesById.get(ruleId),
      findings: list,
      worst: worstStatus(list.map((f) => f.status)),
    };
    const arr = byCategory.get(categoryOf(ruleId));
    if (arr) arr.push(group);
    else byCategory.set(categoryOf(ruleId), [group]);
  }

  for (const arr of byCategory.values()) {
    arr.sort((a, b) => {
      const sa = a.rule ? SEVERITY_ORDER.indexOf(a.rule.severity) : SEVERITY_ORDER.length;
      const sb = b.rule ? SEVERITY_ORDER.indexOf(b.rule.severity) : SEVERITY_ORDER.length;
      if (sa !== sb) return sa - sb;
      return a.ruleId.localeCompare(b.ruleId);
    });
  }
  return byCategory;
}

export function BestPractice({ active, pendingRuleFocus, onConsumePendingRuleFocus }: Props) {
  const t = useT();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [sites, setSites] = useState<SiteEntry[] | null>(null);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);

  const [rules, setRules] = useState<BestPracticeRule[] | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const rulesById = useMemo(() => {
    const m = new Map<string, BestPracticeRule>();
    for (const r of rules ?? []) m.set(r.id, r);
    return m;
  }, [rules]);

  // 結果一覧(診断)⇔ルール一覧(リファレンス)のサブビュー切替。
  // highlightRuleId は結果一覧の「ルール一覧で詳しく見る」から遷移したときだけ立て、
  // ハイライト表示後に RuleReference 側からクリアしてもらう。
  const [view, setView] = useState<BpView>("diagnose");
  const [highlightRuleId, setHighlightRuleId] = useState<string | null>(null);
  const onViewRule = useCallback((ruleId: string) => {
    setView("reference");
    setHighlightRuleId(ruleId);
  }, []);

  // Coach の根拠リンク(65)から飛んできたときの受け口。
  // 他タブの pendingXxx と同じ「マウント時 / 更新時に消費してクリアする」形。
  useEffect(() => {
    if (!pendingRuleFocus) return;
    onViewRule(pendingRuleFocus);
    onConsumePendingRuleFocus?.();
  }, [pendingRuleFocus, onViewRule, onConsumePendingRuleFocus]);

  const [selected, setSelected] = useState<SiteEntry | null>(null);
  const [llmEnabled, setLlmEnabled] = useState(true);

  const [run, setRun] = useState<DiagnosisRun | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runPolling, setRunPolling] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const pollTimer = useRef<number | null>(null);
  const pollAttempts = useRef(0);

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);
  useEffect(() => clearPoll, [clearPoll]);

  const loadSites = useCallback(async (refresh: boolean) => {
    setSitesLoading(true);
    try {
      const res = await fetchSites(refresh);
      if (!mounted.current) return;
      setSites(res.sites);
      setSitesError(null);
    } catch (err) {
      if (mounted.current) setSitesError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSitesLoading(false);
    }
  }, []);

  // 初回だけ: サイト一覧・ルールカタログ(タイトル/根拠 URL)を取得する。
  useEffect(() => {
    if (!active) return;
    if (sites === null && !sitesLoading) void loadSites(false);
    if (rules === null) {
      void fetchRules()
        .then((res) => {
          if (mounted.current) setRules(res.rules);
        })
        .catch((err) => {
          // 結果一覧側は rule カタログが引けなくても判定自体は表示できるので致命扱いしない。
          // 一方でルール一覧(リファレンス)は rule カタログそのものが本体なのでエラーを出す。
          if (mounted.current) setRulesError(err instanceof Error ? err.message : String(err));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // サイト選択が変わったら、直近の実行結果を読みに行く(再実行しなくても前回結果を確認できる)。
  useEffect(() => {
    clearPoll();
    setRunPolling(false);
    setRunError(null);
    setRun(null);
    if (!selected) return;

    let cancelled = false;
    setRunLoading(true);
    void fetchRuns(50)
      .then(async (res) => {
        if (cancelled) return;
        const meta = res.runs.find(
          (r) => r.platform === selected.platform && r.siteId === selected.siteId,
        );
        if (!meta) return;
        const polled = await pollRun(meta.id);
        if (!cancelled && polled.state === "done") setRun(polled.run);
      })
      .catch(() => {
        /* 前回結果が読めなくても「診断実行」からやり直せるので致命扱いしない */
      })
      .finally(() => {
        if (!cancelled && mounted.current) setRunLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected, clearPoll]);

  const onSelectSite = useCallback(
    (key: string) => {
      if (!key) {
        setSelected(null);
        return;
      }
      const idx = key.indexOf(":");
      const platform = key.slice(0, idx) as "central" | "mist";
      const siteId = key.slice(idx + 1);
      const found = (sites ?? []).find((s) => s.platform === platform && s.siteId === siteId);
      setSelected(found ?? null);
    },
    [sites],
  );

  const startPolling = useCallback(
    (runId: string) => {
      clearPoll();
      pollAttempts.current = 0;
      const tick = async () => {
        pollAttempts.current += 1;
        try {
          const res = await pollRun(runId);
          if (!mounted.current) return;
          if (res.state === "done") {
            setRun(res.run);
            setRunPolling(false);
            clearPoll();
            return;
          }
          if (res.state === "not_found" || pollAttempts.current >= MAX_POLL_ATTEMPTS) {
            setRunPolling(false);
            setRunError(t("bestPractice.run.errorPrefix") + "timeout");
            clearPoll();
          }
        } catch (err) {
          if (!mounted.current) return;
          setRunPolling(false);
          setRunError(t("bestPractice.run.errorPrefix") + (err instanceof Error ? err.message : String(err)));
          clearPoll();
        }
      };
      pollTimer.current = window.setInterval(() => void tick(), POLL_MS);
      void tick();
    },
    [clearPoll, t],
  );

  const onRun = useCallback(async () => {
    if (!selected || runPolling) return;
    setRunError(null);
    setRunPolling(true);
    try {
      const res = await startRun({
        platform: selected.platform,
        siteId: selected.siteId,
        siteName: selected.siteName,
        llm: llmEnabled,
      });
      if (!mounted.current) return;
      startPolling(res.runId);
    } catch (err) {
      if (!mounted.current) return;
      setRunPolling(false);
      setRunError(t("bestPractice.run.errorPrefix") + (err instanceof Error ? err.message : String(err)));
    }
  }, [selected, runPolling, llmEnabled, startPolling, t]);

  const centralSites = (sites ?? []).filter((s) => s.platform === "central");
  const mistSites = (sites ?? []).filter((s) => s.platform === "mist");

  return (
    <div className="go-root bp-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("bestPractice.title")}</h1>
          <span className="go-head-sub">{t("bestPractice.headerSub")}</span>
        </div>
        <div className="bp-view-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "diagnose"}
            className={`bp-view-btn${view === "diagnose" ? " active" : ""}`}
            onClick={() => setView("diagnose")}
          >
            {t("bestPractice.view.diagnose")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "reference"}
            className={`bp-view-btn${view === "reference" ? " active" : ""}`}
            onClick={() => setView("reference")}
          >
            {t("bestPractice.view.reference")}
          </button>
        </div>
      </div>

      {view === "reference" && (
        <RuleReference
          t={t}
          rules={rules}
          rulesError={rulesError}
          highlightRuleId={highlightRuleId}
          onHighlightDone={() => setHighlightRuleId(null)}
        />
      )}

      {view === "diagnose" && (
        <>
          {sitesError && <div className="go-error">{sitesError}</div>}

          <div className="bp-controls">
            <label className="bp-site-select">
              {t("bestPractice.site.title")}
              <select
                value={selected ? siteKey(selected.platform, selected.siteId) : ""}
                onChange={(e) => onSelectSite(e.target.value)}
                disabled={sitesLoading}
              >
                <option value="">{t("bestPractice.site.selectPlaceholder")}</option>
                {centralSites.length > 0 && (
                  <optgroup label={t("bestPractice.platform.central")}>
                    {centralSites.map((s) => (
                      <option key={siteKey(s.platform, s.siteId)} value={siteKey(s.platform, s.siteId)}>
                        {s.siteName} ({t("bestPractice.site.apCount", { n: s.apCount })})
                      </option>
                    ))}
                  </optgroup>
                )}
                {mistSites.length > 0 && (
                  <optgroup label={t("bestPractice.platform.mist")}>
                    {mistSites.map((s) => (
                      <option key={siteKey(s.platform, s.siteId)} value={siteKey(s.platform, s.siteId)}>
                        {s.siteName} ({t("bestPractice.site.apCount", { n: s.apCount })})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <button
              className="go-refresh bp-btn-secondary"
              onClick={() => void loadSites(true)}
              disabled={sitesLoading}
            >
              {t("bestPractice.site.refreshBtn")}
            </button>
            <label className="bp-llm-toggle">
              <input type="checkbox" checked={llmEnabled} onChange={(e) => setLlmEnabled(e.target.checked)} />
              {t("bestPractice.run.llmToggle")}
            </label>
            <button className="go-refresh" onClick={() => void onRun()} disabled={!selected || runPolling}>
              {runPolling ? t("bestPractice.run.buttonBusy") : t("bestPractice.run.button")}
            </button>
          </div>
          <div className="go-note">{t("bestPractice.run.hint")}</div>

          {runError && <div className="go-error">{runError}</div>}

          {sitesLoading && sites === null && <div className="go-loading">{t("bestPractice.site.loading")}</div>}
          {!sitesLoading && sites !== null && sites.length === 0 && (
            <div className="go-note">{t("bestPractice.site.empty")}</div>
          )}

          {selected && runLoading && <div className="go-loading">{t("bestPractice.result.loadingPrevious")}</div>}
          {selected && runPolling && <div className="go-loading">{t("bestPractice.result.polling")}</div>}
          {selected && !runLoading && !runPolling && !run && (
            <div className="go-note">{t("bestPractice.result.noRunYet")}</div>
          )}

          {run && (
            <ResultView
              t={t}
              run={run}
              rulesById={rulesById}
              onRerun={() => void onRun()}
              runPolling={runPolling}
              onViewRule={onViewRule}
            />
          )}
        </>
      )}
    </div>
  );
}

function ResultView({
  t,
  run,
  rulesById,
  onRerun,
  runPolling,
  onViewRule,
}: {
  t: TFunc;
  run: DiagnosisRun;
  rulesById: Map<string, BestPracticeRule>;
  onRerun: () => void;
  runPolling: boolean;
  onViewRule: (ruleId: string) => void;
}) {
  const grouped = useMemo(() => groupFindings(run.findings, rulesById), [run.findings, rulesById]);

  return (
    <div className="bp-result">
      <div className="bp-result-meta">
        <span>
          <span className="go-updated-label">{t("bestPractice.result.startedAt")}: </span>
          <span className="go-mono">{formatDateTime(run.startedAt)}</span>
        </span>
        <span>
          <span className="go-updated-label">{t("bestPractice.result.duration")}: </span>
          <span className="go-mono">
            {t("bestPractice.result.durationValue", { s: Math.round(run.durationMs / 1000) })}
          </span>
        </span>
        <span>
          <span className="go-updated-label">{t("bestPractice.result.sampledAp")}: </span>
          <span className="go-mono">
            {run.sampledDeviceIds.length > 0 ? run.sampledDeviceIds.join(", ") : "—"}
          </span>
        </span>
        <button className="go-refresh bp-btn-secondary" onClick={onRerun} disabled={runPolling}>
          {t("bestPractice.result.rerunBtn")}
        </button>
      </div>

      {run.error && <div className="go-error">{t("bestPractice.result.errorRun", { error: run.error })}</div>}

      <div className="bp-summary go-mono">
        {t("bestPractice.result.summary", {
          pass: run.summary.pass,
          warn: run.summary.warn,
          fail: run.summary.fail,
          unknown: run.summary.unknown,
          na: run.summary.not_applicable,
          info: run.summary.info,
        })}
      </div>
      {run.summary.legalReview > 0 && (
        <div className="go-note go-note-warn">
          {t("bestPractice.result.legalReviewNote", { n: run.summary.legalReview })}
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const rulesInCat = grouped.get(cat);
        if (!rulesInCat || rulesInCat.length === 0) return null;
        return (
          <section key={cat} className="bp-category">
            <h2 className="bp-category-title">{t(`bestPractice.category.${cat}`)}</h2>
            <div className="bp-rule-list">
              {rulesInCat.map((g) => (
                <RuleCard key={g.ruleId} t={t} group={g} onViewRule={onViewRule} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 封じ込め系(SEC-10/11)は無効(pass)でも requiresLegalReview が立つが、
 * 「有効化を検討する場合は確認を」という趣旨は有効(warn/fail)のときだけ意味を持つ。
 * summarize() の legalReview 集計(plugins/best-practice/evaluate.ts)と同じ条件に揃える。 */
function needsLegalReviewNote(f: Finding): boolean {
  return Boolean(f.requiresLegalReview) && (f.status === "warn" || f.status === "fail");
}

function RuleCard({
  t,
  group,
  onViewRule,
}: {
  t: TFunc;
  group: RuleGroup;
  onViewRule: (ruleId: string) => void;
}) {
  const { ruleId, rule, findings, worst } = group;
  const isLlm = rule?.method === "llm";
  const anyLegalReview = findings.some(needsLegalReviewNote);
  // fail/warn は説明を読む価値が高いので既定で開いておく。pass/unknown 中心の場合は畳んでおく。
  const defaultOpen = worst === "fail" || worst === "warn";

  return (
    <div className={`bp-rule-card bp-status-${worst}`}>
      <div className="bp-rule-head">
        <span className="bp-rule-id go-mono">{ruleId}</span>
        <span className="bp-rule-title">{rule ? ruleTitle(t, rule) : ruleId}</span>
        {rule && (
          <span className={`bp-badge bp-severity-${rule.severity}`}>
            {t(`bestPractice.severity.${rule.severity}`)}
          </span>
        )}
        {isLlm && <span className="bp-badge bp-badge-llm">{t("bestPractice.llmFinding.badge")}</span>}
        <span className={`bp-badge bp-status-badge bp-status-${worst}`}>
          {t(`bestPractice.verdict.${worst}`)}
        </span>
      </div>

      <ul className="bp-finding-list">
        {findings.map((f, i) => (
          <li key={`${f.targetId}:${i}`} className={`bp-finding-row bp-status-${f.status}`}>
            <span className={`bp-badge bp-status-badge bp-status-${f.status}`}>
              {t(`bestPractice.verdict.${f.status}`)}
            </span>
            <span className="bp-finding-target go-mono">{f.targetLabel}</span>
            <span className="bp-finding-text">{findingText(t, f)}</span>
            {f.status === "unknown" && !isLlm && (
              <span className="bp-finding-note">({t("bestPractice.unknown.note")})</span>
            )}
            {needsLegalReviewNote(f) && (
              <span className="bp-badge bp-badge-legal-small">{t("bestPractice.legalReview.badge")}</span>
            )}
          </li>
        ))}
      </ul>

      {rule && (
        <details className="bp-rule-explain" open={defaultOpen}>
          <summary className="bp-rule-explain-toggle">{t("bestPractice.detail.toggle")}</summary>
          <div className="bp-rule-explain-body">
            <div className="bp-rule-desc">{ruleDesc(t, rule)}</div>
            <dl className="bp-rule-meta">
              <div className="bp-rule-meta-item">
                <dt>{t("bestPractice.detail.category")}</dt>
                <dd>{t(`bestPractice.category.${rule.category}`)}</dd>
              </div>
              <div className="bp-rule-meta-item">
                <dt>{t("bestPractice.detail.priority")}</dt>
                <dd>{t(`bestPractice.severity.${rule.severity}`)}</dd>
              </div>
              <div className="bp-rule-meta-item">
                <dt>{t("bestPractice.detail.method")}</dt>
                <dd>{t(`bestPractice.method.${rule.method}`)}</dd>
              </div>
            </dl>
            {isLlm && <div className="bp-note bp-note-llm">{t("bestPractice.llmFinding.note")}</div>}
            {anyLegalReview && <div className="bp-note bp-note-legal">{t("bestPractice.legalReview.note")}</div>}
            {rule.references.length > 0 && (
              <div className="bp-refs">
                <span className="bp-refs-title">{t("bestPractice.references.title")}: </span>
                {rule.references.map((r) => (
                  <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="bp-ref-link">
                    {r.title}
                  </a>
                ))}
              </div>
            )}
            <button type="button" className="bp-rule-view-ref" onClick={() => onViewRule(ruleId)}>
              {t("bestPractice.detail.openReference")}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
