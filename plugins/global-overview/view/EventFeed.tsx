// 全サイト横断 Event / Alert 一覧(13 Task 2)。独立したタブとして持つ。
//
// なぜ独立画面にできたか(instructions/13_findings.md に実測):
//   Mist は alarms / device-events / client-events すべてに org 一括の窓口があり、22 サイトぶんが
//   3 リクエストで返る。Central の alerts も org スコープで 1 本。
//   Central の events だけは site-id 必須(context-type に ORGANIZATION が無い)ため
//   サイト単位ループになるが、Central サイトは 13 件で 13 本。合計 17 本前後に収まる。
//   → 定期ポーリングには入れず、この画面を開いた時だけ取る(サーバ側 60 秒キャッシュ)。
//
// フィルタは「サイト名 / 重要度 / カテゴリ」+ 種別・プラットフォーム・本文検索。
// 重要度は API ごとに語彙が違う(Critical/Major、critical/warn、negative/neutral/positive)ため
// サーバ側で 3 段階(重大 / 警告 / 情報)へ正規化してある。生の値は行の tooltip に出す。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchEventFeed } from "./api";
import type { FeedEnvelope, FeedItem, FeedSeverity } from "./feedTypes";
import { PLATFORM_SHORT } from "./types";
import { buildInvestigationQuery } from "./investigate";
import { LogoBadge } from "../../network-investigation/view/LogoBadge";
import type { InvestigationRequest } from "../../../src/shell";
import { useT } from "../../../src/i18n/LanguageContext";
import type { TFunc } from "../../../src/i18n/LanguageContext";
import { formatDateTime, formatRelative } from "../../../src/i18n";
import "./styles.css";

/** 一度に描画する行数。全件は数百〜千件になるので、既定は先頭ぶんだけ出す。 */
const PAGE_SIZE = 300;

function sevLabel(t: TFunc, s: FeedSeverity): string {
  return t(`eventFeed.severity.${s}`);
}

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

export function EventFeed({
  active,
  onInvestigate,
}: {
  active: boolean;
  /** 「調査する」ボタン押下時。ネットワーク調査タブへの切り替えは呼び出し側(main.tsx)が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  const t = useT();
  const [feed, setFeed] = useState<FeedEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  // 初回にタブを開いたときだけ自動取得する。以降は「更新」ボタン(外部 API を叩くため)。
  const loadedOnce = useRef(false);

  // フィルタ
  const [kind, setKind] = useState<"all" | "alert" | "event">("all");
  const [platform, setPlatform] = useState<"all" | "central" | "mist">("all");
  const [sev, setSev] = useState<"all" | FeedSeverity>("all");
  const [site, setSite] = useState("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const f = await fetchEventFeed(force);
      if (!mounted.current) return;
      setFeed(f);
      setLimit(PAGE_SIZE);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loadedOnce.current) return;
    loadedOnce.current = true;
    void load(false);
  }, [active, load]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const items = feed?.items ?? [];

  const siteNames = useMemo(
    () => [...new Set(items.map((i) => i.siteName))].sort((a, b) => a.localeCompare(b, "ja")),
    [items],
  );
  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, "ja")),
    [items],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (kind !== "all" && i.kind !== kind) return false;
      if (platform !== "all" && i.platform !== platform) return false;
      if (sev !== "all" && i.severity !== sev) return false;
      if (site !== "all" && i.siteName !== site) return false;
      if (category !== "all" && (i.category ?? "") !== category) return false;
      if (needle) {
        const hay = `${i.text} ${i.type ?? ""} ${i.deviceLabel ?? ""} ${i.siteName}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, kind, platform, sev, site, category, q]);

  const counts = useMemo(() => {
    const c = { alert: 0, event: 0, critical: 0, warning: 0 };
    for (const i of filtered) {
      if (i.kind === "alert") c.alert += 1;
      else c.event += 1;
      if (i.severity === "critical") c.critical += 1;
      else if (i.severity === "warning") c.warning += 1;
    }
    return c;
  }, [filtered]);

  const ageMs = feed ? now - new Date(feed.fetchedAt).getTime() : null;
  const hours = feed ? Math.round(feed.windowSec / 3600) : 24;
  // 取得方式の注記に出すキャッシュ時間(サーバの実値。既定 60 秒)。
  const ttlSec = Math.round((feed?.ttlMs ?? 60_000) / 1000);
  const shown = filtered.slice(0, limit);

  return (
    <div className="go-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">Event / Alert</h1>
          <span className="go-head-sub">{t("eventFeed.headerSub", { hours })}</span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">{t("eventFeed.lastFetched")}</span>
            <span className="go-updated-value">{fmtTime(feed?.fetchedAt ?? null)}</span>
            <span className="go-updated-age">({fmtAge(t, ageMs)})</span>
            {feed?.cached && <span className="go-tag go-tag-dim">{t("eventFeed.cachedTag")}</span>}
            <span className="go-tag go-tag-dim" title={t("eventFeed.noAutoUpdateTitle", { ttl: ttlSec })}>
              {t("eventFeed.noAutoUpdateTag")}
            </span>
          </div>
          <button
            className="go-refresh"
            onClick={() => void load(true)}
            disabled={loading}
            title={t("eventFeed.refreshBtnTitle")}
          >
            {loading ? t("eventFeed.refreshBtnLoading") : t("eventFeed.refreshBtn")}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {loading && !feed && <div className="go-loading">{t("eventFeed.loading")}</div>}

      {feed && (
        <>
          {/* 取得元ごとの成否。1 本でも落ちたら、どれが落ちたか分かるようにする。 */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("eventFeed.sources.title")}</span>
              <span className="go-panel-note">
                {t("eventFeed.sources.summary", { n: feed.requests, total: items.length })}
              </span>
            </header>
            <div className="go-src-list">
              {feed.sources.map((s) => (
                <div key={s.key} className={`go-src${s.status === "error" ? " go-src-bad" : ""}`}>
                  <div className="go-src-head">
                    <LogoBadge target={s.platform} size={13} />
                    <span className="go-src-label">{s.label}</span>
                    {s.status === "ok" ? (
                      <span className="go-src-count">
                        {s.count}
                        {s.total !== null && s.total > s.count && (
                          <span className="go-src-of">{t("eventFeed.sources.ofTotal", { n: s.total })}</span>
                        )}
                      </span>
                    ) : (
                      <span className="go-tag go-tag-bad">{t("eventFeed.sources.failed")}</span>
                    )}
                    <span className="go-src-req go-mono">HTTP {s.requests}</span>
                  </div>
                  <div className="go-src-note">{s.note}</div>
                  {s.error && <div className="go-src-err">{s.error}</div>}
                </div>
              ))}
              {feed.sources.length === 0 && <div className="go-dp-empty">{t("eventFeed.sources.empty")}</div>}
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("eventFeed.filter.title")}</span>
              <span className="go-panel-note">
                {t("eventFeed.filter.summary", {
                  filtered: filtered.length,
                  total: items.length,
                  alert: counts.alert,
                  event: counts.event,
                  critical: counts.critical,
                  warning: counts.warning,
                })}
              </span>
              <button
                className="go-chip"
                onClick={() => {
                  setKind("all");
                  setPlatform("all");
                  setSev("all");
                  setSite("all");
                  setCategory("all");
                  setQ("");
                }}
                title={t("eventFeed.filter.clearTitle")}
              >
                {t("eventFeed.filter.clear")}
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">{t("eventFeed.filter.kind")}</span>
                {(["all", "alert", "event"] as const).map((k) => (
                  <button key={k} className={`go-chip${kind === k ? " go-chip-on" : ""}`} onClick={() => setKind(k)}>
                    {k === "all"
                      ? t("eventFeed.filter.kindAll")
                      : k === "alert"
                        ? t("eventFeed.filter.kindAlert")
                        : t("eventFeed.filter.kindEvent")}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">Platform</span>
                {(["all", "central", "mist"] as const).map((p) => (
                  <button
                    key={p}
                    className={`go-chip${platform === p ? " go-chip-on" : ""}`}
                    onClick={() => setPlatform(p)}
                  >
                    {p === "all" ? t("eventFeed.filter.kindAll") : PLATFORM_SHORT[p]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("eventFeed.filter.severity")}</span>
                {(["all", "critical", "warning", "info"] as const).map((s) => (
                  <button key={s} className={`go-chip${sev === s ? " go-chip-on" : ""}`} onClick={() => setSev(s)}>
                    {s === "all" ? t("eventFeed.filter.kindAll") : sevLabel(t, s)}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("eventFeed.filter.site")}</span>
                <select className="go-fsel" value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="all">{t("eventFeed.filter.siteAllOption", { n: siteNames.length })}</option>
                  {siteNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("eventFeed.filter.category")}</span>
                <select className="go-fsel" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">{t("eventFeed.filter.categoryAllOption", { n: categories.length })}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <input
                  className="go-fsearch"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("eventFeed.filter.searchPlaceholder")}
                />
              </div>
            </div>
          </section>

          {/* 一覧 */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("eventFeed.timeline.title")}</span>
              <span className="go-panel-note">
                {t("eventFeed.timeline.summary", { shown: shown.length, total: filtered.length })}
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table">
                <thead>
                  <tr>
                    <th className="go-fc-time">{t("eventFeed.timeline.col.time")}</th>
                    <th className="go-fc-sev">{t("eventFeed.timeline.col.severity")}</th>
                    <th className="go-fc-kind">{t("eventFeed.timeline.col.kind")}</th>
                    <th className="go-fc-plat">Platform</th>
                    <th className="go-fc-site">{t("eventFeed.timeline.col.site")}</th>
                    <th className="go-fc-cat">{t("eventFeed.timeline.col.category")}</th>
                    <th>{t("eventFeed.timeline.col.content")}</th>
                    <th className="go-fc-act" aria-label={t("eventFeed.timeline.col.action")} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => (
                    <Row key={i.id} item={i} onInvestigate={onInvestigate} />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="go-empty-row" colSpan={8}>
                        {t("eventFeed.timeline.empty")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {shown.length < filtered.length && (
              <div className="go-feed-more">
                <button className="go-chip" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                  {t("eventFeed.timeline.showMore", { n: Math.min(PAGE_SIZE, filtered.length - shown.length) })}
                </button>
              </div>
            )}
          </section>

        </>
      )}

      {/* 取得方式の明示(14 番)。Global Overview のフッタ「ポーリング間隔」と対になる位置。
          データが無い(初回・失敗時)ときも出したいので feed の外に置く。 */}
      <div className="go-foot go-mono">
        <b>{t("eventFeed.noAutoUpdateTag")}</b> — {t("eventFeed.footer", { ttl: ttlSec })}
        {feed && t("eventFeed.footerCentralNote")}
      </div>
    </div>
  );
}

function Row({ item, onInvestigate }: { item: FeedItem; onInvestigate?: (req: InvestigationRequest) => void }) {
  const t = useT();
  return (
    <tr>
      <td className="go-fc-time go-mono">{fmtTime(item.timestamp)}</td>
      <td className="go-fc-sev">
        <span
          className={`go-fsev go-fsev-${item.severity}`}
          title={
            item.severityRaw
              ? t("eventFeed.row.apiValueTitle", { v: item.severityRaw })
              : t("eventFeed.row.noSeverityTitle")
          }
        >
          {sevLabel(t, item.severity)}
          {item.severityRaw === null && <span className="go-fsev-na">*</span>}
        </span>
      </td>
      <td className="go-fc-kind">
        <span className={`go-fkind go-fkind-${item.kind}`}>
          {item.kind === "alert" ? t("eventFeed.filter.kindAlert") : t("eventFeed.filter.kindEvent")}
        </span>
        {item.state && <span className="go-fstate">{item.state}</span>}
      </td>
      <td className="go-fc-plat">
        <span className={`go-plat-tag go-plat-tag-${item.platform}`}>{PLATFORM_SHORT[item.platform]}</span>
      </td>
      <td className="go-fc-site">{item.siteName}</td>
      <td className="go-fc-cat">{item.category ?? "—"}</td>
      <td>
        <div className="go-ftext">{item.text}</div>
        <div className="go-fmeta">
          {item.type && <span className="go-mono">{item.type}</span>}
          {item.deviceLabel && <span>· {item.deviceLabel}</span>}
        </div>
      </td>
      <td className="go-fc-act">
        {onInvestigate && (
          <button
            className="go-investigate-btn"
            title={t("eventFeed.investigateBtnTitle")}
            onClick={() =>
              onInvestigate(
                buildInvestigationQuery({
                  siteName: item.siteName,
                  platform: item.platform,
                  kind: item.kind,
                  severity: sevLabel(t, item.severity),
                  category: item.category,
                  text: item.text,
                  time: fmtTime(item.timestamp),
                }),
              )
            }
          >
            {t("eventFeed.investigateBtn")}
          </button>
        )}
      </td>
    </tr>
  );
}
