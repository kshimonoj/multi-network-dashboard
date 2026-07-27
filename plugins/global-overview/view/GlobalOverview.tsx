// Global Overview 画面(06 Task 2 / Task 3)。
//
// データ源は /api/global-overview/*。GET はサーバのキャッシュ読みだけで外部 API を叩かないので、
// 画面は 30 秒おきに GET /snapshot を引き直してよい(実際の Central/Mist アクセスは
// サーバ側のポーラー = 既定 3 分間隔と、明示的な手動更新だけ)。
//
// アラート件数の扱い(重要):
//   Central は「status = Active」、Mist は「直近 24 時間のアラーム」で母集団が違う。
//   合算値を出す箇所には必ず内訳(Central x Active + Mist y 過去24h)を併記し、
//   単に「アクティブアラート n 件」と読めてしまう表示を作らない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALERT_DESC,
  ALERT_LABEL,
  DEVICE_KINDS,
  DEVICE_KIND_LABEL,
  PLATFORM_LABEL,
  PLATFORM_SHORT,
  type Platform,
  type SiteRow,
  type Snapshot,
  type SnapshotEnvelope,
} from "./types";
import {
  fetchSnapshot,
  refreshSnapshot,
  fetchSettings,
  updatePollInterval,
  type PollSettings,
} from "./api";
import { Donut } from "./Donut";
import { SiteMap, STATE_COLOR, STATE_LABEL, PLATFORM_COLOR, siteKey, siteState } from "./SiteMap";
import { SiteDetailPage } from "./SiteDetailPage";
import { LogoBadge } from "../../network-investigation/view/LogoBadge";
import type { InvestigationRequest } from "../../../src/shell";
import "./styles.css";

const AUTO_RELOAD_MS = 30_000;

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", { hour12: false });
}

function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}

// ---- 小物 ----

function SummaryCard({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
  title?: string;
}) {
  return (
    <div className={`go-card${tone ? ` go-card-${tone}` : ""}`} title={title}>
      <div className="go-card-label">{label}</div>
      <div className="go-card-value">{value}</div>
      {sub && <div className="go-card-sub">{sub}</div>}
    </div>
  );
}

function PlatformPanel({ platform, snapshot }: { platform: Platform; snapshot: Snapshot }) {
  const p = snapshot.platforms[platform];
  return (
    <section className={`go-panel go-plat go-plat-${platform}`}>
      <header className="go-panel-head">
        <LogoBadge target={platform} size={20} />
        <span className="go-panel-title">{PLATFORM_LABEL[platform]}</span>
        {p.ok ? (
          <span className="go-tag go-tag-ok">接続 OK</span>
        ) : (
          <span className="go-tag go-tag-bad">取得失敗</span>
        )}
      </header>

      {!p.ok && p.error && <div className="go-inline-error">{p.error}</div>}

      <div className="go-plat-stats">
        <div className="go-stat">
          <span className="go-stat-value">{p.sites}</span>
          <span className="go-stat-label">サイト</span>
        </div>
        <div className="go-stat">
          <span className="go-stat-value">{p.clients}</span>
          <span className="go-stat-label">クライアント</span>
        </div>
        <div className="go-stat" title={ALERT_DESC[platform]}>
          <span className={`go-stat-value${p.alerts > 0 ? " go-warn" : ""}`}>{p.alerts}</span>
          <span className="go-stat-label">
            アラート<span className="go-alert-tag">{ALERT_LABEL[platform]}</span>
          </span>
        </div>
        <div className="go-stat">
          <span className="go-stat-value">
            {p.deviceUp}
            <span className="go-stat-of">/{p.deviceTotal}</span>
          </span>
          <span className="go-stat-label">デバイス Up</span>
        </div>
      </div>

      <div className="go-donuts">
        {DEVICE_KINDS.map((k) => (
          <Donut key={k} label={DEVICE_KIND_LABEL[k]} counts={p.devices[k]} />
        ))}
      </div>

      <div className="go-plat-foot">
        <span className="go-mono">{ALERT_DESC[platform]}</span>
      </div>
    </section>
  );
}

// ---- サイト別内訳テーブル ----

type SortKey = "site" | "devices" | "down" | "clients" | "alerts" | "health";

function KindCell({ c }: { c: { total: number; up: number; down: number } }) {
  if (c.total === 0) return <span className="go-zero">0</span>;
  return (
    <span className="go-kind">
      <span className="go-kind-total">{c.total}</span>
      <span className="go-kind-split">
        <span className="go-up">{c.up}</span>
        <span className="go-sep">/</span>
        <span className={c.down > 0 ? "go-down" : "go-zero"}>{c.down}</span>
      </span>
    </span>
  );
}

function SiteTable({
  sites,
  highlight,
  onPick,
}: {
  sites: SiteRow[];
  highlight: string | null;
  onPick: (s: SiteRow) => void;
}) {
  const [filter, setFilter] = useState<"all" | Platform>("all");
  const [sortKey, setSortKey] = useState<SortKey>("site");
  const [asc, setAsc] = useState(true);

  const rows = useMemo(() => {
    const base = filter === "all" ? sites : sites.filter((s) => s.platform === filter);
    const dir = asc ? 1 : -1;
    const val = (s: SiteRow): number | string => {
      switch (sortKey) {
        case "devices":
          return s.deviceTotal;
        case "down":
          return s.deviceDown;
        case "clients":
          return s.clients;
        case "alerts":
          return s.alerts;
        case "health":
          // null(未取得)は常に末尾に置く。0 と混ざらないようにする。
          return s.healthScore === null ? (asc ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : s.healthScore;
        default:
          return s.siteName.toLowerCase();
      }
    };
    return [...base].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv), "ja") * dir;
      }
      if (av === bv) return a.siteName.localeCompare(b.siteName, "ja");
      return (av - bv) * dir;
    });
  }, [sites, filter, sortKey, asc]);

  // note は定義の但し書き(アラートの母集団など)。並び替え矢印は必ずラベルと同じ行に出す。
  const th = (key: SortKey, label: string, cls?: string, note?: string) => (
    <th
      className={`go-th-sort${cls ? ` ${cls}` : ""}${sortKey === key ? " go-th-active" : ""}`}
      onClick={() => {
        if (sortKey === key) setAsc((v) => !v);
        else {
          setSortKey(key);
          setAsc(key === "site");
        }
      }}
      title="クリックで並び替え"
    >
      <span className="go-th-line">
        {label}
        <span className="go-th-arrow">{sortKey === key ? (asc ? "▲" : "▼") : ""}</span>
      </span>
      {note && <span className="go-th-note">{note}</span>}
    </th>
  );

  return (
    <section className="go-panel go-table-panel">
      <header className="go-panel-head">
        <span className="go-panel-title">サイト別内訳</span>
        <span className="go-panel-note">{rows.length} サイト</span>
        <div className="go-filter">
          {(["all", "central", "mist"] as const).map((f) => (
            <button
              key={f}
              className={`go-chip${filter === f ? " go-chip-on" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "すべて" : PLATFORM_SHORT[f]}
            </button>
          ))}
        </div>
      </header>

      <div className="go-table-scroll">
        <table className="go-table">
          <thead>
            <tr>
              {th("site", "サイト")}
              <th className="go-col-plat">Platform</th>
              <th className="go-col-kind">AP</th>
              <th className="go-col-kind">Switch</th>
              <th className="go-col-kind">Gateway</th>
              {th("devices", "デバイス計", "go-col-num")}
              {th("down", "Down", "go-col-num")}
              {th("clients", "クライアント", "go-col-num")}
              {th("alerts", "アラート", "go-col-num", "Central=Active / Mist=過去24h")}
              {th("health", "健全性", "go-col-num", "Central のみ / Mist は未取得")}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const st = siteState(s);
              const key = siteKey(s);
              return (
                <tr
                  key={key}
                  className={highlight === key ? "go-row-hl" : undefined}
                  onClick={() => onPick(s)}
                >
                  <td className="go-col-site">
                    <span
                      className="go-dot"
                      style={{ background: STATE_COLOR[st], borderColor: PLATFORM_COLOR[s.platform] }}
                      title={STATE_LABEL[st]}
                    />
                    <span className="go-site-name">{s.siteName}</span>
                    {!s.inSiteMap && (
                      <span className="go-tag go-tag-dim" title="サイト対応表(site-platform-map.json)に未登録">
                        未登録
                      </span>
                    )}
                  </td>
                  <td className="go-col-plat">
                    <span className={`go-plat-tag go-plat-tag-${s.platform}`}>{PLATFORM_SHORT[s.platform]}</span>
                  </td>
                  <td className="go-col-kind">
                    <KindCell c={s.devices.ap} />
                  </td>
                  <td className="go-col-kind">
                    <KindCell c={s.devices.switch} />
                  </td>
                  <td className="go-col-kind">
                    <KindCell c={s.devices.gateway} />
                  </td>
                  <td className="go-col-num">{s.deviceTotal}</td>
                  <td className="go-col-num">
                    {s.deviceDown > 0 ? <span className="go-down">{s.deviceDown}</span> : <span className="go-zero">0</span>}
                  </td>
                  <td className="go-col-num">{s.clients}</td>
                  <td className="go-col-num" title={ALERT_DESC[s.platform]}>
                    {s.alerts > 0 ? <span className="go-warn">{s.alerts}</span> : <span className="go-zero">0</span>}
                    <span className="go-alert-tag">{ALERT_LABEL[s.platform]}</span>
                  </td>
                  <td className="go-col-num">
                    {s.healthScore === null ? (
                      <span className="go-na" title="このプラットフォームでは健全性スコアを取得していません(値なし)">
                        —
                      </span>
                    ) : (
                      <span className={s.healthScore >= 80 ? "go-up" : s.healthScore >= 50 ? "go-warn" : "go-down"}>
                        {s.healthScore}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="go-empty-row" colSpan={10}>
                  該当するサイトがありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- 画面本体 ----

export function GlobalOverview({
  active,
  theme,
  onInvestigate,
}: {
  active: boolean;
  theme: "dark" | "light";
  /** サイト詳細ページの「調査する」ボタン押下時(15番)。SiteDetailPage へそのまま渡す */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  const [env, setEnv] = useState<SnapshotEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // 手動更新のクールダウン(サーバ側の最短間隔と同じ長さだけボタンを塞ぐ)。
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<string | null>(null);
  // 行 / ピンのクリックで開くサイト詳細の対象(11 番)。13 番から全画面表示に変更したので、
  // これが立っているあいだは一覧を hidden にして詳細ページと入れ替える。
  const [detailTarget, setDetailTarget] = useState<SiteRow | null>(null);
  const [fitToken, setFitToken] = useState(0);
  // ポーリング間隔の設定(Task 4)。
  const [settings, setSettings] = useState<PollSettings | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const e = await fetchSnapshot();
      if (!mounted.current) return;
      setEnv(e);
      setError(e.snapshot ? null : (e.error ?? "スナップショットがまだありません。"));
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // 初回 + 自動再読込。GET はキャッシュ読みなので外部 API は起きない。
  // タブが非表示のあいだは止める(見えていない画面のために叩き続けない)。
  useEffect(() => {
    if (!active) return;
    void load();
    const id = window.setInterval(() => void load(), AUTO_RELOAD_MS);
    return () => window.clearInterval(id);
  }, [active, load]);

  // 「n 分前」表示とクールダウン残りを動かすためのティック。
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  // ポーリング間隔の現在値・選択肢を取得(Task 4)。
  useEffect(() => {
    if (!active || settings) return;
    fetchSettings()
      .then((s) => mounted.current && setSettings(s))
      .catch(() => undefined);
  }, [active, settings]);

  const onChangeInterval = useCallback(async (ms: number) => {
    setSavingInterval(true);
    try {
      const s = await updatePollInterval(ms);
      if (!mounted.current) return;
      setSettings(s);
      // 反映後のスナップショット封筒(pollIntervalMs 表示)も更新する。
      void load();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSavingInterval(false);
    }
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const e = await refreshSnapshot();
      if (!mounted.current) return;
      setEnv(e);
      if (!e.snapshot) setError(e.error ?? "取得に失敗しました。");
      // サーバの最短間隔ぶんは押せないようにする(押しても外部 API は叩かれないが、
      // 「効いていないのに押せる」ボタンにしない)。
      setCooldownUntil(Date.now() + (e.minRefreshMs ?? 60_000));
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setCooldownUntil(Date.now() + 10_000);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  const snapshot = env?.snapshot ?? null;
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const ageMs = snapshot ? now - new Date(snapshot.generatedAt).getTime() : null;

  const central = snapshot?.platforms.central;
  const mist = snapshot?.platforms.mist;

  // 行 / ピンのクリック: 該当ピンをハイライト・地図を寄せ、詳細パネルを開く。
  const onPick = useCallback((s: SiteRow) => {
    setPicked(siteKey(s));
    setDetailTarget(s);
  }, []);

  // 一覧は「詳細を開いているあいだも hidden でマウントしたまま」にする。
  // 条件レンダリングにすると Leaflet 地図が作り直されて視点・スナップショットの表示状態が飛ぶため。
  return (
    <>
    <div className="go-root" hidden={detailTarget !== null}>
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">Global Overview</h1>
          <span className="go-head-sub">HPE Aruba Central / Juniper Mist — 直接 API</span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">最終更新</span>
            <span className="go-updated-value">{fmtTime(snapshot?.generatedAt)}</span>
            <span className="go-updated-age">({fmtAge(ageMs)})</span>
            {env?.stale && <span className="go-tag go-tag-warn">古い可能性</span>}
          </div>
          <button
            className="go-refresh"
            onClick={() => void onRefresh()}
            disabled={refreshing || cooldownLeft > 0}
            title={
              cooldownLeft > 0
                ? `サーバ側の最短取得間隔(${Math.round((env?.minRefreshMs ?? 60000) / 1000)} 秒)を待っています`
                : "Central / Mist から取り直します"
            }
          >
            {refreshing ? "更新中…" : cooldownLeft > 0 ? `更新 (${cooldownLeft}s)` : "更新"}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}

      {loading && !snapshot && <div className="go-loading">読み込み中…</div>}

      {snapshot && (
        <>
          {/* ---- Global Summary ---- */}
          <section className="go-cards">
            <SummaryCard
              label="総サイト数"
              value={snapshot.totals.sites}
              sub={
                <>
                  Central {central?.sites ?? 0}
                  <span className="go-sep">/</span>
                  Mist {mist?.sites ?? 0}
                </>
              }
            />
            <SummaryCard
              label="総デバイス数"
              value={snapshot.totals.devices}
              tone={snapshot.totals.devicesDown > 0 ? "warn" : "ok"}
              sub={
                <>
                  <span className="go-up">Up {snapshot.totals.devicesUp}</span>
                  <span className="go-sep">/</span>
                  <span className={snapshot.totals.devicesDown > 0 ? "go-down" : "go-zero"}>
                    Down {snapshot.totals.devicesDown}
                  </span>
                </>
              }
            />
            <SummaryCard
              label="接続クライアント数"
              value={snapshot.totals.clients}
              sub={
                <>
                  Central {central?.clients ?? 0}
                  <span className="go-sep">/</span>
                  Mist {mist?.clients ?? 0}
                </>
              }
            />
            <SummaryCard
              label="アラート合計"
              value={snapshot.totals.alerts}
              tone={snapshot.totals.alerts > 0 ? "bad" : "ok"}
              title={`${ALERT_DESC.central}\n${ALERT_DESC.mist}`}
              sub={
                <>
                  Central {central?.alerts ?? 0}
                  <span className="go-alert-tag">{ALERT_LABEL.central}</span>
                  <span className="go-sep">/</span>
                  Mist {mist?.alerts ?? 0}
                  <span className="go-alert-tag">{ALERT_LABEL.mist}</span>
                </>
              }
            />
          </section>
          <div className="go-note">
            アラートは定義が異なるため単純合算では比較できません — Central は <b>status = Active</b>(未解消)、
            Mist は <b>直近 24 時間</b>のアラーム(解消済みを含む)です。
          </div>

          {/* ---- プラットフォーム別 ---- */}
          <div className="go-plats">
            <PlatformPanel platform="central" snapshot={snapshot} />
            <PlatformPanel platform="mist" snapshot={snapshot} />
          </div>

          {/* ---- MAP ---- */}
          <section className="go-panel go-map-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">サイトマップ</span>
              <span className="go-panel-note">
                {snapshot.sites.filter((s) => s.lat !== null && s.lng !== null).length} / {snapshot.sites.length} サイトに位置情報
              </span>
              <button
                className="go-chip"
                onClick={() => {
                  setPicked(null);
                  setFitToken((v) => v + 1);
                }}
                title="全サイトが入る範囲に戻す"
              >
                全体表示
              </button>
              <div className="go-legend">
                <span className="go-legend-group">
                  <span className="go-legend-cap">枠 =</span>
                  <span className="go-legend-item">
                    <span className="go-dot" style={{ background: "transparent", borderColor: PLATFORM_COLOR.central }} />
                    Central
                  </span>
                  <span className="go-legend-item">
                    <span className="go-dot" style={{ background: "transparent", borderColor: PLATFORM_COLOR.mist }} />
                    Mist
                  </span>
                </span>
                <span className="go-legend-group">
                  <span className="go-legend-cap">塗り =</span>
                  {(["down", "alert", "ok", "empty"] as const).map((st) => (
                    <span className="go-legend-item" key={st}>
                      <span className="go-dot" style={{ background: STATE_COLOR[st], borderColor: "transparent" }} />
                      {STATE_LABEL[st]}
                    </span>
                  ))}
                </span>
              </div>
            </header>
            <SiteMap
              sites={snapshot.sites}
              theme={theme}
              // 詳細ページを開いているあいだは非表示扱い。戻ってきた瞬間に invalidateSize が走り、
              // display:none 中にリサイズされた地図のタイル欠けを防ぐ。
              active={active && detailTarget === null}
              focusKey={picked}
              fitToken={fitToken}
              onSelect={onPick}
            />
          </section>

          {/* ---- サイト別内訳 ---- */}
          <SiteTable sites={snapshot.sites} highlight={picked} onPick={onPick} />

          {snapshot.siteMapOnly.length > 0 && (
            <div className="go-note go-note-warn">
              サイト対応表にあるが今回の API 応答に現れなかったサイト({snapshot.siteMapOnly.length} 件):{" "}
              {snapshot.siteMapOnly.map((s) => `${s.siteName}(${PLATFORM_SHORT[s.platform]})`).join(", ")}
            </div>
          )}

          <div className="go-foot go-mono">
            <span className="go-foot-interval">
              ポーリング間隔
              <select
                className="go-interval-select"
                value={settings?.pollIntervalMs ?? env?.pollIntervalMs ?? 300000}
                disabled={savingInterval || !settings}
                onChange={(e) => void onChangeInterval(Number(e.target.value))}
                title="定期ポーリングの間隔を変更します(サーバに保存され、コンテナ再作成後も保持されます)"
              >
                {(settings?.optionsMs ?? [60000, 180000, 300000, 600000, 900000]).map((ms) => (
                  <option key={ms} value={ms}>
                    {ms % 60000 === 0 ? `${ms / 60000} 分` : `${Math.round(ms / 1000)} 秒`}
                  </option>
                ))}
              </select>
              {savingInterval && <span className="go-interval-saving"> 保存中…</span>}
              {/* 14 番: Event / Alert タブは別方式(オンデマンド取得)なので、ここで取り違えないようにする。 */}
              <span
                className="go-foot-hint"
                title="Event / Alert タブは自動更新されず、タブを開いたとき・「更新」を押したときだけ取得します(サーバ側 60 秒キャッシュ)。"
              >
                (この設定は Global Overview の自動更新のみ / Event / Alert タブには適用されません)
              </span>
            </span>
            {" / "}手動更新の最短間隔 {Math.round((env?.minRefreshMs ?? 0) / 1000)} 秒 ・ 直近取得の HTTP 本数: Central{" "}
            {central?.requests ?? 0} / Mist {mist?.requests ?? 0}
          </div>
        </>
      )}

    </div>
      {detailTarget && (
        <SiteDetailPage site={detailTarget} onBack={() => setDetailTarget(null)} onInvestigate={onInvestigate} />
      )}
    </>
  );
}
