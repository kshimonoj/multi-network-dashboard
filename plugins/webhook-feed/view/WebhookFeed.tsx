// Webhook ログ タブ(17 Task 3)。
//
// New Central / Classic Central / Mist の Webhook が Google Apps Script 経由で書き込んでいる
// スプレッドシート 3 シートを、サーバ側で統合スキーマに落としたものを表示する。
//
// 画面の骨格・クラス名は Global Overview の EventFeed.tsx を踏襲する(見た目を揃えるため
// go-* クラスをそのまま使い、この画面固有のものだけ wf-* を足す)。
// ただし取得方式は異なる:
//   Event / Alert タブ … 自動更新なし(タブを開いたときだけ Central / Mist を直接叩く)
//   Webhook ログ タブ … サーバが定期ポーリング(既定 5 分)。間隔はこの画面のフッタで変更でき、
//                        Global Overview の間隔設定とは独立して保存される(Task 3-4)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchWebhookFeed,
  fetchWebhookSettings,
  refreshWebhookFeed,
  updateWebhookArchiveRetention,
  updateWebhookPollInterval,
} from "./api";
import {
  SOURCE_ORDER,
  SOURCE_SHORT,
  type WebhookFeedEnvelope,
  type WebhookFeedItem,
  type WebhookPollSettings,
  type WebhookSeverity,
  type WebhookSource,
} from "./types";
import { buildFollowUpQuery, buildWebhookInvestigationQuery } from "./investigate";
import type { InvestigationRequest } from "../../../src/shell";
import { useT } from "../../../src/i18n/LanguageContext";
import type { TFunc } from "../../../src/i18n/LanguageContext";
import { formatDateTime, formatNumber, formatRelative } from "../../../src/i18n";
import "../../global-overview/view/styles.css";
import "./styles.css";

/** 一度に描画する行数。MistLog は数百行あるので既定は先頭ぶんだけ出す。 */
const PAGE_SIZE = 200;

/** 画面を開いているあいだ、サーバのキャッシュをこの間隔で読み直す(外部 API は叩かれない)。 */
const VIEW_POLL_MS = 15_000;

function fmtTime(iso: string | null): string {
  // 33 L-10: toLocaleString("ja-JP") のハードコードをやめ、表示言語に追従させる
  // (ja のときの出力は従来と同じ)。
  return formatDateTime(iso);
}

function fmtAge(t: TFunc, ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  // 33 L-11: 分岐は src/i18n/format.ts に集約した(4 タブの重複実装を 1 箇所へ)。
  // このタブは 30〜32 の時点で日をまたいでも「n 時間前」だったので maxUnit で踏襲する。
  return formatRelative(t, ms, { maxUnit: "hour" });
}

/** 保存サイズ。単位記号はロケール非依存なので数値だけ表示言語に合わせる。 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n < 1024 * 1024) return `${formatNumber(Math.max(1, Math.round(n / 1024)))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtInterval(t: TFunc, ms: number): string {
  if (ms % 3_600_000 === 0) return t("webhookFeed.footer.hours", { n: ms / 3_600_000 });
  if (ms % 60000 === 0) return t("webhookFeed.footer.minutes", { n: ms / 60000 });
  return t("webhookFeed.footer.seconds", { n: Math.round(ms / 1000) });
}

function sevLabel(t: TFunc, s: WebhookSeverity): string {
  return s === "unknown" ? "—" : t(`webhookFeed.severity.${s}`);
}

export function WebhookFeed({
  active,
  onInvestigate,
  onOpenHistoryFocus,
}: {
  active: boolean;
  /** 「調査する」ボタン押下時。ネットワーク調査タブへの切り替えは呼び出し側(main.tsx)が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
  /** 「調査結果を見る」ボタン押下時(18番)。自動事前調査の runId を渡し、その実行結果の
   * スレッドをネットワーク調査タブで直接開く。タブ切り替えは呼び出し側(main.tsx)が行う */
  onOpenHistoryFocus?: (runId: string) => void;
}) {
  const t = useT();
  const [feed, setFeed] = useState<WebhookFeedEnvelope | null>(null);
  const [settings, setSettings] = useState<WebhookPollSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  // フィルタ
  const [source, setSource] = useState<"all" | WebhookSource>("all");
  const [sev, setSev] = useState<"all" | WebhookSeverity>("all");
  const [site, setSite] = useState("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [autoOnly, setAutoOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const f = await fetchWebhookFeed();
      if (!mounted.current) return;
      setFeed(f);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // タブを開いているあいだだけ、サーバのキャッシュを読み直す(Sheets は叩かれない)。
  // 自動事前調査が「実行中 → 完了」に変わるのもこの巡回で反映される。
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void load();
    };
    setLoading(feed === null);
    tick();
    const id = window.setInterval(tick, VIEW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // feed は初回ローディング表示の判定にしか使わないので依存に入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load]);

  useEffect(() => {
    if (feed !== null) setLoading(false);
  }, [feed]);

  useEffect(() => {
    if (!active || settings) return;
    fetchWebhookSettings()
      .then((s) => mounted.current && setSettings(s))
      .catch(() => undefined);
  }, [active, settings]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const f = await refreshWebhookFeed();
      if (mounted.current) {
        setFeed(f);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  const onChangeInterval = useCallback(
    async (ms: number) => {
      setSavingInterval(true);
      try {
        const s = await updateWebhookPollInterval(ms);
        if (!mounted.current) return;
        setSettings(s);
        void load();
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setSavingInterval(false);
      }
    },
    [load],
  );

  // 42: 保存(日別アーカイブ)の保持日数。一覧の表示件数とは別枠の設定。
  const onChangeRetention = useCallback(async (days: number) => {
    setSavingRetention(true);
    try {
      const s = await updateWebhookArchiveRetention(days);
      if (!mounted.current) return;
      setSettings(s);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSavingRetention(false);
    }
  }, []);

  const items = feed?.items ?? [];

  const siteNames = useMemo(
    () =>
      [...new Set(items.map((i) => i.siteName).filter((s): s is string => Boolean(s)))].sort((a, b) =>
        a.localeCompare(b, "ja"),
      ),
    [items],
  );
  const categories = useMemo(
    () =>
      [...new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))].sort((a, b) =>
        a.localeCompare(b, "ja"),
      ),
    [items],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (source !== "all" && i.source !== source) return false;
      if (sev !== "all" && i.severity !== sev) return false;
      if (site !== "all" && (i.siteName ?? "") !== site) return false;
      if (category !== "all" && (i.category ?? "") !== category) return false;
      if (autoOnly && !i.auto) return false;
      if (needle) {
        const hay = `${i.message} ${i.type ?? ""} ${i.category ?? ""} ${i.deviceLabel ?? ""} ${
          i.siteName ?? ""
        } ${i.siteId ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, source, sev, site, category, q, autoOnly]);

  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, auto: 0 };
    for (const i of filtered) {
      if (i.severity === "critical") c.critical += 1;
      else if (i.severity === "warning") c.warning += 1;
      if (i.auto) c.auto += 1;
    }
    return c;
  }, [filtered]);

  const ageMs = feed?.generatedAt ? now - new Date(feed.generatedAt).getTime() : null;
  const shown = filtered.slice(0, limit);
  const intervalMs = settings?.pollIntervalMs ?? feed?.pollIntervalMs ?? 300_000;

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="go-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("webhookFeed.title")}</h1>
          <span className="go-head-sub">
            {feed?.spreadsheetTitle
              ? t("webhookFeed.headerSubWithTitle", { title: feed.spreadsheetTitle })
              : t("webhookFeed.headerSubNoTitle")}
          </span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">{t("webhookFeed.lastFetched")}</span>
            <span className="go-updated-value">{fmtTime(feed?.generatedAt ?? null)}</span>
            <span className="go-updated-age">({fmtAge(t, ageMs)})</span>
            {feed?.stale && <span className="go-tag go-tag-dim">{t("webhookFeed.staleTag")}</span>}
          </div>
          <button
            className="go-refresh"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            title={t("webhookFeed.refresh.title", { s: Math.round((feed?.minRefreshMs ?? 30000) / 1000) })}
          >
            {refreshing ? t("webhookFeed.refresh.running") : t("webhookFeed.refresh.button")}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {/* 85: 失敗が続いていることを目立たせる(16 時間止まっていても気づけなかった反省)。 */}
      {feed?.health && feed.health.consecutiveFailures > 0 && (
        <div className="go-error wf-health-alert" role="alert">
          <strong>
            {t(feed.health.partial ? "webhookFeed.health.failingPartial" : "webhookFeed.health.failing", {
              n: feed.health.consecutiveFailures,
            })}
          </strong>{" "}
          {!feed.health.partial &&
            t("webhookFeed.health.lastSuccess", {
              time: fmtTime(feed.generatedAt),
              age: fmtAge(t, ageMs),
            })}{" "}
          {feed.health.nextRetryAt
            ? t("webhookFeed.health.nextRetry", { time: fmtTime(feed.health.nextRetryAt) })
            : t("webhookFeed.health.nextCycle")}
          {feed.configured && feed.health.lastError && (
            <div className="wf-health-reason">{feed.health.lastError}</div>
          )}
        </div>
      )}
      {feed && !feed.configured && feed.configError && (
        <div className="go-error">
          {t("webhookFeed.error.configPrefix")}
          {feed.configError}
        </div>
      )}
      {loading && !feed && <div className="go-loading">{t("webhookFeed.loading")}</div>}

      {feed && (
        <>
          {/* 取得元シートごとの読み取り位置と成否 */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("webhookFeed.sheets.title")}</span>
              <span className="go-panel-note">{t("webhookFeed.sheets.totalCount", { n: items.length })}</span>
            </header>
            <div className="go-src-list">
              {feed.sheets.map((s) => (
                <div key={s.sheet} className={`go-src${s.status === "error" ? " go-src-bad" : ""}`}>
                  <div className="go-src-head">
                    <span className={`wf-src-tag wf-src-${s.source}`}>{SOURCE_SHORT[s.source]}</span>
                    <span className="go-src-label">{s.sheet}</span>
                    {s.status === "ok" ? (
                      <span className="go-src-count">{s.items}</span>
                    ) : (
                      <span className="go-tag go-tag-bad">{t("webhookFeed.sheets.failedTag")}</span>
                    )}
                    <span className="go-src-req go-mono">
                      {t("webhookFeed.sheets.readCount", { n: Math.max(0, s.lastRow - 1) })}
                      {s.newRows > 0
                        ? t("webhookFeed.sheets.readCountDelta", { n: s.newRows })
                        : s.status === "ok"
                          ? t("webhookFeed.sheets.readCountNone")
                          : ""}
                    </span>
                  </div>
                  <div className="go-src-note">
                    {t("webhookFeed.sheets.nextRowNote", { n: s.lastRow + 1 })}
                  </div>
                  {s.error && <div className="go-src-err">{s.error}</div>}
                </div>
              ))}
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("webhookFeed.filter.title")}</span>
              <span className="go-panel-note">
                {t("webhookFeed.filter.summary", {
                  filtered: filtered.length,
                  total: items.length,
                  critical: counts.critical,
                  warning: counts.warning,
                  auto: counts.auto,
                })}
              </span>
              <button
                className="go-chip"
                onClick={() => {
                  setSource("all");
                  setSev("all");
                  setSite("all");
                  setCategory("all");
                  setQ("");
                  setAutoOnly(false);
                }}
                title={t("webhookFeed.filter.clearTitle")}
              >
                {t("webhookFeed.filter.clear")}
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">{t("webhookFeed.filter.source")}</span>
                {(["all", ...SOURCE_ORDER] as const).map((s) => (
                  <button
                    key={s}
                    className={`go-chip${source === s ? " go-chip-on" : ""}`}
                    onClick={() => setSource(s as "all" | WebhookSource)}
                  >
                    {s === "all" ? t("webhookFeed.filter.all") : SOURCE_SHORT[s as WebhookSource]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("webhookFeed.filter.severity")}</span>
                {(["all", "critical", "warning", "info", "unknown"] as const).map((s) => (
                  <button key={s} className={`go-chip${sev === s ? " go-chip-on" : ""}`} onClick={() => setSev(s)}>
                    {s === "all"
                      ? t("webhookFeed.filter.all")
                      : s === "unknown"
                        ? t("webhookFeed.filter.severityNone")
                        : sevLabel(t, s)}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("webhookFeed.filter.site")}</span>
                <select className="go-fsel" value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="all">{t("webhookFeed.filter.allWithCount", { n: siteNames.length })}</option>
                  {siteNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("webhookFeed.filter.category")}</span>
                <select className="go-fsel" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">{t("webhookFeed.filter.allWithCount", { n: categories.length })}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <button
                  className={`go-chip${autoOnly ? " go-chip-on" : ""}`}
                  onClick={() => setAutoOnly((v) => !v)}
                  title={t("webhookFeed.filter.autoOnlyTitle")}
                >
                  {t("webhookFeed.filter.autoOnly")}
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <input
                  className="go-fsearch"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("webhookFeed.filter.searchPlaceholder")}
                />
              </div>
            </div>
          </section>

          {/* 一覧 */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("webhookFeed.table.title")}</span>
              <span className="go-panel-note">
                {t("webhookFeed.table.summary", { shown: shown.length, filtered: filtered.length })}
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table wf-table">
                <thead>
                  <tr>
                    <th className="wf-c-exp" aria-label={t("webhookFeed.table.col.expand")} />
                    <th className="go-fc-time">{t("webhookFeed.table.col.time")}</th>
                    <th className="go-fc-sev">{t("webhookFeed.table.col.severity")}</th>
                    <th className="wf-c-src">{t("webhookFeed.table.col.source")}</th>
                    <th className="go-fc-site">{t("webhookFeed.table.col.site")}</th>
                    <th className="go-fc-cat">{t("webhookFeed.table.col.category")}</th>
                    <th>{t("webhookFeed.table.col.content")}</th>
                    <th className="go-fc-act" aria-label={t("webhookFeed.table.col.action")} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => (
                    <Row
                      key={i.id}
                      item={i}
                      open={expanded.has(i.id)}
                      onToggle={() => toggle(i.id)}
                      onInvestigate={onInvestigate}
                      onOpenHistoryFocus={onOpenHistoryFocus}
                    />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="go-empty-row" colSpan={8}>
                        {t("webhookFeed.table.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {shown.length < filtered.length && (
              <div className="go-feed-more">
                <button className="go-chip" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                  {t("webhookFeed.table.showMore", { n: Math.min(PAGE_SIZE, filtered.length - shown.length) })}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      {/* 取得方式・自動更新間隔。Global Overview のフッタと対になる位置に置くが、設定は別物。 */}
      <div className="go-foot go-mono">
        <span className="go-foot-interval">
          <b>{t("webhookFeed.footer.pollInterval")}</b>
          <select
            className="go-interval-select"
            value={intervalMs}
            disabled={savingInterval || !settings}
            onChange={(e) => void onChangeInterval(Number(e.target.value))}
            title={t("webhookFeed.footer.intervalTitle")}
          >
            {(
              settings?.optionsMs ?? [
                60000, 180000, 300000, 600000, 900000, 1800000, 3_600_000, 86_400_000,
              ]
            ).map((ms) => (
              <option key={ms} value={ms}>
                {fmtInterval(t, ms)}
              </option>
            ))}
          </select>
          {savingInterval && <span className="go-interval-saving"> {t("webhookFeed.footer.saving")}</span>}
          <span className="go-foot-hint" title={t("webhookFeed.footer.hintTitle")}>
            {t("webhookFeed.footer.hintNote")}
          </span>
        </span>
        {feed && (
          <>
            {" / "}
            {t("webhookFeed.footer.minRefresh", { s: Math.round(feed.minRefreshMs / 1000) })}
            {" ・ "}
            {t("webhookFeed.footer.autoLabel")}:{" "}
            {feed.auto.enabled
              ? t("webhookFeed.footer.autoEnabledDetail", {
                  max: feed.auto.maxPerCycle,
                  age: Math.round(feed.auto.maxAgeMs / 60000),
                  done: feed.auto.investigatedCount,
                })
              : t("webhookFeed.footer.autoDisabled")}
          </>
        )}
      </div>

      {/* 42: 「表示している量」と「保存している量」は別物であることを明示する。
          一覧は直近 N 件しか読まないが、保存は日別ファイルなので上限で欠落しない。 */}
      <div className="go-foot go-mono">
        <span className="go-foot-interval">
          <b>{t("webhookFeed.footer.storageLabel")}</b>
          <select
            className="go-interval-select"
            value={settings?.archiveRetentionDays ?? 90}
            disabled={savingRetention || !settings}
            onChange={(e) => void onChangeRetention(Number(e.target.value))}
            title={t("webhookFeed.footer.retentionTitle")}
          >
            {(settings?.archiveRetentionOptionsDays ?? [0, 30, 90, 180, 365]).map((d) => (
              <option key={d} value={d}>
                {d === 0 ? t("webhookFeed.footer.retentionForever") : t("webhookFeed.footer.retentionDays", { n: d })}
              </option>
            ))}
          </select>
          {savingRetention && <span className="go-interval-saving"> {t("webhookFeed.footer.saving")}</span>}
        </span>
        {feed?.storage && (
          <>
            {" "}
            {t("webhookFeed.footer.storageStored", {
              days: feed.storage.days,
              items: formatNumber(feed.storage.items),
              size: fmtBytes(feed.storage.bytes),
              from: feed.storage.oldestDay ?? "—",
              to: feed.storage.newestDay ?? "—",
            })}
            {" / "}
            {t("webhookFeed.footer.storageShown", {
              items: formatNumber(feed.storage.viewItems),
              max: formatNumber(feed.storage.viewMaxItems),
            })}
            <span className="go-foot-hint" title={t("webhookFeed.footer.storageTitle")}>
              {t("webhookFeed.footer.storageNote")}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  item,
  open,
  onToggle,
  onInvestigate,
  onOpenHistoryFocus,
}: {
  item: WebhookFeedItem;
  open: boolean;
  onToggle: () => void;
  onInvestigate?: (req: InvestigationRequest) => void;
  onOpenHistoryFocus?: (runId: string) => void;
}) {
  const t = useT();
  const hasDetail = Boolean(item.auto || item.siteContext || Object.keys(item.raw).length > 0);
  const hasHistoryResult = Boolean(
    onOpenHistoryFocus && item.auto?.status === "done" && item.auto.runId,
  );
  return (
    <>
      <tr
        className={`${open ? "wf-row-open" : ""}${hasDetail ? " wf-row-click" : ""}`.trim()}
        onClick={hasDetail ? onToggle : undefined}
        title={
          hasDetail
            ? open
              ? t("webhookFeed.row.trCloseTitle")
              : t("webhookFeed.row.trOpenTitle")
            : undefined
        }
      >
        <td className="wf-c-exp">
          <button
            className="wf-exp-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            title={open ? t("webhookFeed.row.btnCloseTitle") : t("webhookFeed.row.btnOpenTitle")}
            disabled={!hasDetail}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td className="go-fc-time go-mono">{fmtTime(item.receivedAt)}</td>
        <td className="go-fc-sev">
          <span
            className={`go-fsev wf-sev-${item.severity}`}
            title={
              item.severityRaw
                ? t("webhookFeed.row.sevRawTitle", { v: item.severityRaw })
                : t("webhookFeed.row.sevNoneTitle")
            }
          >
            {sevLabel(t, item.severity)}
          </span>
        </td>
        <td className="wf-c-src">
          <span className={`wf-src-tag wf-src-${item.source}`}>{SOURCE_SHORT[item.source]}</span>
        </td>
        <td className="go-fc-site">
          {item.siteName ?? (item.siteId ? <span className="go-mono wf-dim">{item.siteId}</span> : "—")}
        </td>
        <td className="go-fc-cat">{item.category ?? "—"}</td>
        <td>
          <div className="go-ftext">{item.message}</div>
          <div className="go-fmeta">
            {item.type && <span className="go-mono">{item.type}</span>}
            {item.state && <span>· {item.state}</span>}
            {item.deviceLabel && <span>· {item.deviceLabel}</span>}
            {item.auto && (
              <span className={`wf-auto-tag wf-auto-${item.auto.status}`}>
                {item.auto.status === "running"
                  ? t("webhookFeed.row.autoTag.running")
                  : item.auto.status === "done"
                    ? t("webhookFeed.row.autoTag.done")
                    : t("webhookFeed.row.autoTag.error")}
              </span>
            )}
          </div>
        </td>
        <td className="go-fc-act wf-c-act">
          <div className="wf-act-col">
            {hasHistoryResult && (
              <button
                className="wf-history-btn"
                title={t("webhookFeed.row.historyBtnTitle")}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenHistoryFocus!(item.auto!.runId!);
                }}
              >
                {t("webhookFeed.row.historyBtn")}
              </button>
            )}
            {onInvestigate && (
              <button
                className="go-investigate-btn"
                title={
                  item.auto?.status === "done"
                    ? t("webhookFeed.row.investigateBtnTitleFollowUp")
                    : t("webhookFeed.row.investigateBtnTitleNew")
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onInvestigate(
                    item.auto?.status === "done"
                      ? buildFollowUpQuery(item)
                      : buildWebhookInvestigationQuery(item),
                  );
                }}
              >
                {t("webhookFeed.row.investigateBtn")}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="wf-detail-row">
          <td colSpan={8}>
            <div className="wf-detail">
              {item.auto && <AutoPanel item={item} />}
              {item.siteContext && <SitePanel item={item} />}
              <div className="wf-dsec">
                <div className="wf-dsec-title">
                  {t("webhookFeed.detail.rawTitle", { sheet: item.sheet, row: item.rowIndex })}
                </div>
                <dl className="wf-raw">
                  {Object.entries(item.raw).map(([k, v]) => (
                    <div className="wf-raw-row" key={k}>
                      <dt>{k}</dt>
                      <dd className="go-mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AutoPanel({ item }: { item: WebhookFeedItem }) {
  const t = useT();
  const a = item.auto!;
  return (
    <div className="wf-dsec wf-dsec-auto">
      <div className="wf-dsec-title">
        {t("webhookFeed.auto.title")}
        <span className={`wf-auto-tag wf-auto-${a.status}`}>
          {a.status === "running"
            ? t("webhookFeed.auto.status.running")
            : a.status === "done"
              ? t("webhookFeed.auto.status.done")
              : t("webhookFeed.auto.status.error")}
        </span>
        <span className="go-mono wf-dim">
          {fmtTime(a.startedAt)}
          {a.finishedAt ? ` → ${fmtTime(a.finishedAt)}` : ""}
        </span>
      </div>
      <div className="wf-auto-query go-mono">{t("webhookFeed.auto.queryLabel", { query: a.query })}</div>
      {a.status === "running" && <div className="wf-auto-body wf-dim">{t("webhookFeed.auto.runningBody")}</div>}
      {a.status === "error" && (
        <div className="go-src-err">{a.error ?? t("webhookFeed.auto.errorDefault")}</div>
      )}
      {a.status === "done" && (
        <div className="wf-auto-body">{a.summary || t("webhookFeed.auto.emptyAnswer")}</div>
      )}
      {a.runId && (
        <div className="wf-auto-foot go-mono wf-dim">
          {t("webhookFeed.auto.footNote", { runId: a.runId })}
        </div>
      )}
    </div>
  );
}

function SitePanel({ item }: { item: WebhookFeedItem }) {
  const t = useT();
  const s = item.siteContext!;
  if (s.status === "unavailable") {
    return (
      <div className="wf-dsec">
        <div className="wf-dsec-title">{t("webhookFeed.site.title")}</div>
        <div className="wf-dim">{s.error ?? t("webhookFeed.site.unavailableDefault")}</div>
      </div>
    );
  }
  if (s.status === "error") {
    return (
      <div className="wf-dsec">
        <div className="wf-dsec-title">{t("webhookFeed.site.title")}</div>
        <div className="go-src-err">
          {t("webhookFeed.site.fetchFailedPrefix")}
          {s.error}
        </div>
      </div>
    );
  }
  return (
    <div className="wf-dsec wf-dsec-site">
      <div className="wf-dsec-title">
        {t("webhookFeed.site.title")}
        <span className="go-mono wf-dim">
          {t("webhookFeed.site.meta", { site: s.siteName ?? "", time: fmtTime(s.fetchedAt) })}
        </span>
      </div>
      <div className="wf-kpis">
        <div className="wf-kpi">
          <span className="wf-kpi-label">Health</span>
          <span className="wf-kpi-value">{s.healthScore === null ? "—" : s.healthScore}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">{t("webhookFeed.site.kpi.devices")}</span>
          <span className="wf-kpi-value">
            {s.devicesTotal === null ? "—" : `${s.devicesUp ?? 0} / ${s.devicesTotal}`}
          </span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">{t("webhookFeed.site.kpi.clients")}</span>
          <span className="wf-kpi-value">{s.clients ?? "—"}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">{t("webhookFeed.site.kpi.openAlerts")}</span>
          <span className="wf-kpi-value">{s.openAlerts ?? "—"}</span>
        </div>
      </div>
      {s.healthMetrics.length > 0 && (
        <div className="wf-metrics">
          {s.healthMetrics.map((m) => (
            <span className="wf-metric" key={m.label}>
              <span className="wf-metric-label">{m.label}</span>
              <span className="wf-metric-value go-mono">
                {m.value === null ? "—" : `${m.value}${m.unit ?? ""}`}
              </span>
            </span>
          ))}
        </div>
      )}
      {s.topAlerts.length > 0 && (
        <ul className="wf-alerts">
          {s.topAlerts.map((a, idx) => (
            <li key={idx}>
              <span className="wf-alert-sev go-mono">{a.severity ?? "—"}</span>
              <span>{a.summary}</span>
              {a.createdAt && <span className="go-mono wf-dim"> · {fmtTime(a.createdAt)}</span>}
            </li>
          ))}
        </ul>
      )}
      {s.alertsNote && (
        <div className="wf-dim go-mono">
          {t("webhookFeed.site.alertsNotePrefix")}
          {s.alertsNote}
        </div>
      )}
    </div>
  );
}
