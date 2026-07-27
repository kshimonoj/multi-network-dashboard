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
import "./styles.css";

/** 一度に描画する行数。全件は数百〜千件になるので、既定は先頭ぶんだけ出す。 */
const PAGE_SIZE = 300;

const SEV_LABEL: Record<FeedSeverity, string> = {
  critical: "重大",
  warning: "警告",
  info: "情報",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ja-JP", { hour12: false });
}

function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  return `${Math.floor(m / 60)} 時間前`;
}

export function EventFeed({
  active,
  onInvestigate,
}: {
  active: boolean;
  /** 「調査する」ボタン押下時。ネットワーク調査タブへの切り替えは呼び出し側(main.tsx)が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
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
          <span className="go-head-sub">全サイト横断 — 直近 {hours}h・オンデマンド取得</span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">最終取得</span>
            <span className="go-updated-value">{fmtTime(feed?.fetchedAt ?? null)}</span>
            <span className="go-updated-age">({fmtAge(ageMs)})</span>
            {feed?.cached && <span className="go-tag go-tag-dim">キャッシュ</span>}
            <span
              className="go-tag go-tag-dim"
              title={`このタブは自動更新されません。タブを開いたとき・「更新」を押したときだけ Central / Mist から取得し、サーバ側で ${ttlSec} 秒キャッシュします(Global Overview のポーリング間隔設定は適用されません)。`}
            >
              自動更新なし
            </span>
          </div>
          <button
            className="go-refresh"
            onClick={() => void load(true)}
            disabled={loading}
            title="Central / Mist から取り直します(定期ポーリングには含まれません)"
          >
            {loading ? "取得中…" : "更新"}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {loading && !feed && <div className="go-loading">Event / Alert を取得中…(Central はサイト単位で取得するため数秒かかります)</div>}

      {feed && (
        <>
          {/* 取得元ごとの成否。1 本でも落ちたら、どれが落ちたか分かるようにする。 */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">取得元</span>
              <span className="go-panel-note">
                HTTP {feed.requests} 本 · 全 {items.length} 件
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
                          <span className="go-src-of"> / 全 {s.total}</span>
                        )}
                      </span>
                    ) : (
                      <span className="go-tag go-tag-bad">失敗</span>
                    )}
                    <span className="go-src-req go-mono">HTTP {s.requests}</span>
                  </div>
                  <div className="go-src-note">{s.note}</div>
                  {s.error && <div className="go-src-err">{s.error}</div>}
                </div>
              ))}
              {feed.sources.length === 0 && (
                <div className="go-dp-empty">取得元がありません(Central / Mist の資格情報が未設定です)</div>
              )}
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">フィルタ</span>
              <span className="go-panel-note">
                {filtered.length} / {items.length} 件(アラート {counts.alert} · イベント {counts.event} ·
                重大 {counts.critical} · 警告 {counts.warning})
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
                title="すべてのフィルタを解除する"
              >
                クリア
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">種別</span>
                {(["all", "alert", "event"] as const).map((k) => (
                  <button key={k} className={`go-chip${kind === k ? " go-chip-on" : ""}`} onClick={() => setKind(k)}>
                    {k === "all" ? "すべて" : k === "alert" ? "アラート" : "イベント"}
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
                    {p === "all" ? "すべて" : PLATFORM_SHORT[p]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">重要度</span>
                {(["all", "critical", "warning", "info"] as const).map((s) => (
                  <button key={s} className={`go-chip${sev === s ? " go-chip-on" : ""}`} onClick={() => setSev(s)}>
                    {s === "all" ? "すべて" : SEV_LABEL[s]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">サイト</span>
                <select className="go-fsel" value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="all">すべて({siteNames.length})</option>
                  {siteNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">カテゴリ</span>
                <select className="go-fsel" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="all">すべて({categories.length})</option>
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
                  placeholder="本文 / 種別 / デバイスで絞り込み"
                />
              </div>
            </div>
          </section>

          {/* 一覧 */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">タイムライン</span>
              <span className="go-panel-note">
                新しい順 · {shown.length} / {filtered.length} 件を表示
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table">
                <thead>
                  <tr>
                    <th className="go-fc-time">時刻</th>
                    <th className="go-fc-sev">重要度</th>
                    <th className="go-fc-kind">種別</th>
                    <th className="go-fc-plat">Platform</th>
                    <th className="go-fc-site">サイト</th>
                    <th className="go-fc-cat">カテゴリ</th>
                    <th>内容</th>
                    <th className="go-fc-act" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => (
                    <Row key={i.id} item={i} onInvestigate={onInvestigate} />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="go-empty-row" colSpan={8}>
                        条件に一致する Event / Alert はありません
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {shown.length < filtered.length && (
              <div className="go-feed-more">
                <button className="go-chip" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                  さらに {Math.min(PAGE_SIZE, filtered.length - shown.length)} 件を表示
                </button>
              </div>
            )}
          </section>

        </>
      )}

      {/* 取得方式の明示(14 番)。Global Overview のフッタ「ポーリング間隔」と対になる位置。
          データが無い(初回・失敗時)ときも出したいので feed の外に置く。 */}
      <div className="go-foot go-mono">
        <b>自動更新なし</b> — このタブはタブを開いたとき・「更新」を押したときだけ Central / Mist から取得し、
        サーバ側で {ttlSec} 秒キャッシュします(Global Overview のポーリング間隔設定は適用されません)。
        {feed && " Central のイベントのみサイト単位で取得しています。"}
      </div>
    </div>
  );
}

function Row({ item, onInvestigate }: { item: FeedItem; onInvestigate?: (req: InvestigationRequest) => void }) {
  return (
    <tr>
      <td className="go-fc-time go-mono">{fmtTime(item.timestamp)}</td>
      <td className="go-fc-sev">
        <span
          className={`go-fsev go-fsev-${item.severity}`}
          title={item.severityRaw ? `API の値: ${item.severityRaw}` : "この API は重要度を返しません"}
        >
          {SEV_LABEL[item.severity]}
          {item.severityRaw === null && <span className="go-fsev-na">*</span>}
        </span>
      </td>
      <td className="go-fc-kind">
        <span className={`go-fkind go-fkind-${item.kind}`}>{item.kind === "alert" ? "アラート" : "イベント"}</span>
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
            title="この事案の要約をクエリ文にして、ネットワーク調査タブへ渡します(実行はされません)"
            onClick={() =>
              onInvestigate(
                buildInvestigationQuery({
                  siteName: item.siteName,
                  platform: item.platform,
                  kind: item.kind,
                  severity: SEV_LABEL[item.severity],
                  category: item.category,
                  text: item.text,
                  time: fmtTime(item.timestamp),
                }),
              )
            }
          >
            調査する
          </button>
        )}
      </td>
    </tr>
  );
}
