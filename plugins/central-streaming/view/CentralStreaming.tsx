// Streaming(Central)タブ(20 Task 4)。
//
// New Central の Streaming API(WSS + CloudEvents + protobuf)を **サーバ側が** 購読し、
// この画面はサーバのメモリに溜まったものを一定間隔で読んで表示する。
// ブラウザから Central へ直接 WebSocket を張ることはしない(トークンをブラウザに出さないため)。
//
// 画面の骨格・クラス名は Webhook ログ / Event/Alert タブと揃える(go-* をそのまま使い、
// この画面固有のものだけ cs-* を足す)。
//
// 自動調査(重大アラートの事前調査)は 20 番の方針どおり実装していない。
// 各イベントに severity 相当のフィールドが無く、自動実行の判断基準を持てないため。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearStreamEvents,
  fetchStreamCatalog,
  fetchStreamSnapshot,
  forceStreamDisconnect,
  purgeStreamEvents,
  updateStreamSettings,
} from "./api";
import {
  STREAM_SHORT,
  type StreamConnState,
  type StreamEndpointDef,
  type StreamEnvelope,
  type StreamEvent,
  type StreamKey,
  type StreamSettings,
  type StreamStatus,
} from "./types";
import { buildStreamInvestigationQuery } from "./investigate";
import type { InvestigationRequest } from "../../../src/shell";
import { useT } from "../../../src/i18n/LanguageContext";
import type { TFunc } from "../../../src/i18n/LanguageContext";
import { formatDateTime, formatNumber, formatRelative } from "../../../src/i18n";
import "../../global-overview/view/styles.css";
import "./styles.css";

/** 一度に描画する行数。 */
const PAGE_SIZE = 200;
/** 画面を開いているあいだ、サーバの状態を読み直す間隔。 */
const VIEW_POLL_MS = 5_000;

function fmtTime(iso: string | null): string {
  // 33 L-10: toLocaleString("ja-JP") のハードコードをやめ、表示言語に追従させる
  // (ja のときの出力は従来と同じ)。
  return formatDateTime(iso);
}

function fmtAge(t: TFunc, iso: string | null, now: number): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  // 33 L-11: 分岐は src/i18n/format.ts に集約した(4 タブの重複実装を 1 箇所へ)。
  return formatRelative(t, now - ts);
}

function fmtCountdown(t: TFunc, iso: string | null, now: number): string {
  if (!iso) return "";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.round((ts - now) / 1000));
  if (s < 60) return t(s === 1 ? "centralStreaming.retry.inSecondsOne" : "centralStreaming.retry.inSecondsOther", { n: s });
  const m = Math.floor(s / 60);
  return t(m === 1 ? "centralStreaming.retry.inMinutesOne" : "centralStreaming.retry.inMinutesOther", { n: m });
}

function stateLabel(t: TFunc, state: StreamConnState): string {
  return t(`centralStreaming.state.${state}`);
}

function volumeLabel(t: TFunc, volume: StreamEndpointDef["volume"]): string {
  return t(`centralStreaming.volume.${volume}`);
}

function endpointLabel(t: TFunc, key: StreamKey): string {
  return t(`centralStreaming.endpoint.${key}.label`);
}

function endpointNote(t: TFunc, key: StreamKey): string {
  return t(`centralStreaming.endpoint.${key}.note`);
}

/** イベント種別カタログのラベルを i18n 辞書から引く。サーバの label(日本語固定)は表示に使わない。 */
function eventTypeLabel(t: TFunc, streamKey: StreamKey, key: string): string {
  switch (streamKey) {
    case "audit-trail":
      return t(`centralStreaming.auditSubtype.${key}`);
    case "ap-monitoring":
      return t(`centralStreaming.apEventType.${key}`);
    case "geofence":
      return t(`centralStreaming.geofenceEventType.${key}`);
    case "location":
      return t(`centralStreaming.locationEventType.${key}`);
    case "location-analytics":
      return t(`centralStreaming.rssiEventType.${key}`);
    default:
      return key;
  }
}

export function CentralStreaming({
  active,
  onInvestigate,
}: {
  active: boolean;
  /** 「調査する」ボタン押下時。タブ切り替えは呼び出し側(main.tsx)が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  const t = useT();
  const [env, setEnv] = useState<StreamEnvelope | null>(null);
  const [catalog, setCatalog] = useState<StreamEndpointDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 二段階 UI の 1 段目: どのストリームのサブタイプを編集しているか */
  const [editing, setEditing] = useState<StreamKey | null>(null);
  const mounted = useRef(true);

  // フィルタ
  const [streamFilter, setStreamFilter] = useState<"all" | StreamKey>("all");
  const [q, setQ] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
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
      const e = await fetchStreamSnapshot();
      if (!mounted.current) return;
      setEnv(e);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void load();
    };
    tick();
    const id = window.setInterval(tick, VIEW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, load]);

  useEffect(() => {
    if (!active || catalog.length) return;
    fetchStreamCatalog()
      .then((c) => mounted.current && setCatalog(c.endpoints))
      .catch(() => undefined);
  }, [active, catalog.length]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const save = useCallback(
    async (patch: Partial<StreamSettings>) => {
      setBusy(true);
      try {
        const r = await updateStreamSettings(patch);
        if (!mounted.current) return;
        setEnv((prev) => (prev ? { ...prev, settings: r.settings, streams: r.streams } : prev));
        setError(null);
        // 接続状態はサーバ側で数百 ms 後に変わるので、少し待って読み直す。
        window.setTimeout(() => void load(), 800);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [load],
  );

  const settings = env?.settings ?? null;
  const items = env?.items ?? [];

  const onToggleAll = useCallback(() => {
    if (!settings) return;
    void save({ enabled: !settings.enabled });
  }, [settings, save]);

  const onToggleStream = useCallback(
    (key: StreamKey) => {
      if (!settings) return;
      void save({
        streams: {
          ...settings.streams,
          [key]: { ...settings.streams[key], enabled: !settings.streams[key].enabled },
        },
      });
    },
    [settings, save],
  );

  const onToggleType = useCallback(
    (key: StreamKey, typeId: string) => {
      if (!settings) return;
      const cur = settings.streams[key].eventTypes;
      const next = cur.includes(typeId) ? cur.filter((t) => t !== typeId) : [...cur, typeId];
      void save({
        streams: { ...settings.streams, [key]: { ...settings.streams[key], eventTypes: next } },
      });
    },
    [settings, save],
  );

  const onSetAllTypes = useCallback(
    (key: StreamKey, all: string[] | null) => {
      if (!settings) return;
      void save({
        streams: { ...settings.streams, [key]: { ...settings.streams[key], eventTypes: all ?? [] } },
      });
    },
    [settings, save],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      if (streamFilter !== "all" && i.stream !== streamFilter) return false;
      if (errorsOnly && !i.decodeError) return false;
      if (needle) {
        const hay = `${i.summary} ${i.typeLabel} ${i.type} ${i.category ?? ""} ${i.deviceLabel ?? ""} ${
          i.siteName ?? ""
        } ${i.siteId ?? ""} ${i.actor ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, streamFilter, q, errorsOnly]);

  const shown = filtered.slice(0, limit);

  const toggleRow = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onDisconnectTest = useCallback(
    async (key: StreamKey) => {
      try {
        const r = await forceStreamDisconnect(key);
        if (mounted.current) setError(r.ok ? null : `${key}: ${r.note}`);
        window.setTimeout(() => void load(), 500);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      }
    },
    [load],
  );

  const catalogOf = useCallback(
    (key: StreamKey) => catalog.find((c) => c.key === key) ?? null,
    [catalog],
  );

  return (
    <div className="go-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("centralStreaming.title")}</h1>
          <span className="go-head-sub">{t("centralStreaming.headerSub")}</span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">{t("centralStreaming.stored.label")}</span>
            <span className="go-updated-value">{t("centralStreaming.stored.value", { n: env?.stored ?? 0 })}</span>
            <span className="go-updated-age">
              {t("centralStreaming.stored.age", { age: fmtAge(t, env?.generatedAt ?? null, now) })}
            </span>
          </div>
          <button
            className={`cs-master${settings?.enabled ? " cs-master-on" : ""}`}
            onClick={onToggleAll}
            disabled={busy || !settings || !env?.configured}
            title={
              settings?.enabled
                ? t("centralStreaming.masterToggle.onTitle")
                : t("centralStreaming.masterToggle.offTitle")
            }
          >
            <span className="cs-master-dot" aria-hidden />
            {settings?.enabled ? t("centralStreaming.masterToggle.on") : t("centralStreaming.masterToggle.off")}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {env && !env.configured && env.configError && (
        <div className="go-error">
          {t("centralStreaming.error.configPrefix")}
          {env.configError}
        </div>
      )}
      {!env && <div className="go-loading">{t("centralStreaming.loading")}</div>}

      {env && settings && (
        <>
          {/* 接続状態 + ストリームごとのトグル(二段階 UI の 1 段目) */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("centralStreaming.connPanel.title")}</span>
              <span className="go-panel-note">{t("centralStreaming.connPanel.note")}</span>
            </header>
            <div className="cs-conns">
              {env.streams.map((s) => (
                <ConnCard
                  key={s.key}
                  t={t}
                  status={s}
                  def={catalogOf(s.key)}
                  masterOn={settings.enabled}
                  busy={busy}
                  now={now}
                  editing={editing === s.key}
                  onToggle={() => onToggleStream(s.key)}
                  onEdit={() => setEditing((v) => (v === s.key ? null : s.key))}
                  onDisconnect={() => void onDisconnectTest(s.key)}
                />
              ))}
            </div>
          </section>

          {/* イベント種別の選択(二段階 UI の 2 段目) */}
          {editing && (
            <TypePicker
              t={t}
              streamKey={editing}
              def={catalogOf(editing)}
              selected={settings.streams[editing].eventTypes}
              busy={busy}
              onToggleType={(id) => onToggleType(editing, id)}
              onSelectAll={() => onSetAllTypes(editing, catalogOf(editing)?.eventTypes.map((et) => et.id) ?? [])}
              onSelectNone={() => onSetAllTypes(editing, [])}
              onClose={() => setEditing(null)}
            />
          )}

          {/* Retention */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("centralStreaming.retention.title")}</span>
              <span className="go-panel-note">
                {t("centralStreaming.retention.noteBase", { n: env.stored })}
                {env.lastPurgeAt
                  ? t("centralStreaming.retention.lastPurge", { time: fmtTime(env.lastPurgeAt), n: env.lastPurged })
                  : t("centralStreaming.retention.noPurgeYet")}
              </span>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">{t("centralStreaming.retention.daysLabel")}</span>
                <select
                  className="go-fsel"
                  value={settings.retentionDays}
                  disabled={busy}
                  onChange={(e) => void save({ retentionDays: Number(e.target.value) })}
                  title={t("centralStreaming.retention.daysTitle")}
                >
                  {env.retentionOptionsDays.map((d) => (
                    <option key={d} value={d}>
                      {t("centralStreaming.retention.daysOption", { n: d })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">{t("centralStreaming.retention.maxEventsLabel")}</span>
                <select
                  className="go-fsel"
                  value={settings.maxEvents}
                  disabled={busy}
                  onChange={(e) => void save({ maxEvents: Number(e.target.value) })}
                  title={t("centralStreaming.retention.maxEventsTitle")}
                >
                  {env.maxEventsOptions.map((n) => (
                    <option key={n} value={n}>
                      {t("centralStreaming.retention.maxEventsOption", { n: formatNumber(n) })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <button
                  className="go-chip"
                  disabled={busy}
                  onClick={() => void purgeStreamEvents().then(() => load())}
                  title={t("centralStreaming.retention.purgeNowTitle")}
                >
                  {t("centralStreaming.retention.purgeNow")}
                </button>
                <button
                  className="go-chip"
                  disabled={busy}
                  onClick={() => void clearStreamEvents().then(() => load())}
                  title={t("centralStreaming.retention.clearAllTitle")}
                >
                  {t("centralStreaming.retention.clearAll")}
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <span className="go-foot-hint">{t("centralStreaming.retention.hint")}</span>
              </div>
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("centralStreaming.filter.title")}</span>
              <span className="go-panel-note">
                {t("centralStreaming.filter.summary", { filtered: filtered.length, total: items.length })}
              </span>
              <button
                className="go-chip"
                onClick={() => {
                  setStreamFilter("all");
                  setQ("");
                  setErrorsOnly(false);
                }}
              >
                {t("centralStreaming.filter.clear")}
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">{t("centralStreaming.filter.streamLabel")}</span>
                <button
                  className={`go-chip${streamFilter === "all" ? " go-chip-on" : ""}`}
                  onClick={() => setStreamFilter("all")}
                >
                  {t("centralStreaming.filter.all")}
                </button>
                {env.streams.map((s) => (
                  <button
                    key={s.key}
                    className={`go-chip${streamFilter === s.key ? " go-chip-on" : ""}`}
                    onClick={() => setStreamFilter(s.key)}
                  >
                    {STREAM_SHORT[s.key]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <button
                  className={`go-chip${errorsOnly ? " go-chip-on" : ""}`}
                  onClick={() => setErrorsOnly((v) => !v)}
                  title={t("centralStreaming.filter.decodeErrorsOnlyTitle")}
                >
                  {t("centralStreaming.filter.decodeErrorsOnly")}
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <input
                  className="go-fsearch"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("centralStreaming.filter.searchPlaceholder")}
                />
              </div>
            </div>
          </section>

          {/* タイムライン */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">{t("centralStreaming.table.title")}</span>
              <span className="go-panel-note">
                {t("centralStreaming.table.summary", { shown: shown.length, filtered: filtered.length })}
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table cs-table">
                <thead>
                  <tr>
                    <th className="cs-c-exp" aria-label={t("centralStreaming.table.col.expand")} />
                    <th className="go-fc-time">{t("centralStreaming.table.col.time")}</th>
                    <th className="cs-c-stream">{t("centralStreaming.table.col.stream")}</th>
                    <th className="go-fc-cat">{t("centralStreaming.table.col.type")}</th>
                    <th className="go-fc-site">{t("centralStreaming.table.col.site")}</th>
                    <th>{t("centralStreaming.table.col.content")}</th>
                    <th className="go-fc-act" aria-label={t("centralStreaming.table.col.action")} />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((ev) => (
                    <Row
                      key={ev.id}
                      t={t}
                      ev={ev}
                      open={expanded.has(ev.id)}
                      onToggle={() => toggleRow(ev.id)}
                      onInvestigate={onInvestigate}
                    />
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="go-empty-row" colSpan={7}>
                        {settings.enabled
                          ? t("centralStreaming.table.emptyEnabled")
                          : t("centralStreaming.table.emptyDisabled")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {shown.length < filtered.length && (
              <div className="go-feed-more">
                <button className="go-chip" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
                  {t("centralStreaming.table.showMore", { n: Math.min(PAGE_SIZE, filtered.length - shown.length) })}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <div className="go-foot go-mono">
        {t("centralStreaming.footer.body")
          .split("{server}")
          .flatMap((part, i) =>
            i === 0 ? [part] : [<b key="server-label">{t("centralStreaming.footer.serverLabel")}</b>, part],
          )}
        {env?.streams.find((s) => s.tokenExpiresAt)?.tokenExpiresAt && (
          <>
            {t("centralStreaming.footer.tokenExpiry", {
              time: fmtTime(env.streams.find((s) => s.tokenExpiresAt)!.tokenExpiresAt),
            })}
          </>
        )}
        {t("centralStreaming.footer.noAutoInvestigate")}
      </div>
    </div>
  );
}

// ---- ストリーム 1 件のカード ----

function ConnCard({
  t,
  status,
  def,
  masterOn,
  busy,
  now,
  editing,
  onToggle,
  onEdit,
  onDisconnect,
}: {
  t: TFunc;
  status: StreamStatus;
  def: StreamEndpointDef | null;
  masterOn: boolean;
  busy: boolean;
  now: number;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const selectedCount = status.eventTypes.length;
  const total = def?.eventTypes.length ?? 0;
  return (
    <div className={`cs-conn cs-state-${status.state}${status.enabled ? " cs-conn-on" : ""}`}>
      <div className="cs-conn-head">
        <label className="cs-check">
          <input type="checkbox" checked={status.enabled} disabled={busy} onChange={onToggle} />
          <span className="cs-conn-label">{endpointLabel(t, status.key)}</span>
        </label>
        <span className={`cs-badge cs-badge-${status.state}`}>{stateLabel(t, status.state)}</span>
      </div>
      <div className="cs-conn-meta go-mono">
        <span>{t("centralStreaming.conn.received", { n: formatNumber(status.received) })}</span>
        <span>{t("centralStreaming.conn.last", { age: fmtAge(t, status.lastEventAt, now) })}</span>
        {def && <span className={`cs-vol cs-vol-${def.volume}`}>{volumeLabel(t, def.volume)}</span>}
      </div>
      <div className="cs-conn-types">
        {selectedCount === 0
          ? t("centralStreaming.conn.typesAll", { n: total })
          : t("centralStreaming.conn.typesSelected", { selected: selectedCount, total })}
        <button className="go-chip cs-edit" onClick={onEdit} disabled={busy}>
          {editing ? t("centralStreaming.conn.close") : t("centralStreaming.conn.edit")}
        </button>
      </div>
      {status.state === "reconnecting" && status.nextRetryAt && (
        <div className="cs-conn-note">
          {t("centralStreaming.conn.nextRetry", { countdown: fmtCountdown(t, status.nextRetryAt, now) })}
        </div>
      )}
      {status.lastError && (
        <div className={status.state === "error" ? "go-src-err" : "cs-conn-note"}>{status.lastError}</div>
      )}
      {status.url && (
        <div className="cs-conn-url go-mono" title={status.url}>
          {status.url.replace(/^wss:\/\/[^/]+/, "")}
        </div>
      )}
      {masterOn && status.state === "open" && (
        <button
          className="go-chip cs-disc"
          onClick={onDisconnect}
          title={t("centralStreaming.conn.disconnectTestTitle")}
        >
          {t("centralStreaming.conn.disconnectTest")}
        </button>
      )}
    </div>
  );
}

// ---- イベント種別の選択(二段階 UI の 2 段目) ----

function TypePicker({
  t,
  streamKey,
  def,
  selected,
  busy,
  onToggleType,
  onSelectAll,
  onSelectNone,
  onClose,
}: {
  t: TFunc;
  streamKey: StreamKey;
  def: StreamEndpointDef | null;
  selected: string[];
  busy: boolean;
  onToggleType: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClose: () => void;
}) {
  if (!def) return null;
  const sel = new Set(selected);
  return (
    <section className="go-panel cs-picker">
      <header className="go-panel-head">
        <span className="go-panel-title">
          {t("centralStreaming.picker.title", { label: endpointLabel(t, streamKey) })}
        </span>
        <span className="go-panel-note">{t("centralStreaming.picker.note")}</span>
        <button className="go-chip" onClick={onSelectNone} disabled={busy}>
          {t("centralStreaming.picker.selectNone")}
        </button>
        <button className="go-chip" onClick={onSelectAll} disabled={busy}>
          {t("centralStreaming.picker.selectAll")}
        </button>
        <button className="go-chip" onClick={onClose}>
          {t("centralStreaming.picker.close")}
        </button>
      </header>
      <div className="cs-picker-note">{endpointNote(t, streamKey)}</div>
      <div className="cs-types">
        {def.eventTypes.map((et) => (
          <label key={et.id} className={`cs-type${sel.has(et.id) ? " cs-type-on" : ""}`} title={et.id}>
            <input
              type="checkbox"
              checked={sel.has(et.id)}
              disabled={busy}
              onChange={() => onToggleType(et.id)}
            />
            <span className="cs-type-label">{eventTypeLabel(t, streamKey, et.key)}</span>
            <span className="cs-type-msg go-mono">{et.message.split(".").pop()}</span>
          </label>
        ))}
      </div>
      <div className="cs-picker-foot go-mono">
        {t("centralStreaming.picker.footer", { path: def.path, protoFile: def.protoFile })}
      </div>
    </section>
  );
}

// ---- タイムラインの 1 行 ----

function Row({
  t,
  ev,
  open,
  onToggle,
  onInvestigate,
}: {
  t: TFunc;
  ev: StreamEvent;
  open: boolean;
  onToggle: () => void;
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  const where = ev.siteName ?? (ev.siteId ? `ID ${ev.siteId}` : null);
  return (
    <>
      <tr
        className={`cs-row-click${open ? " cs-row-open" : ""}`}
        onClick={onToggle}
        title={open ? t("centralStreaming.row.trCloseTitle") : t("centralStreaming.row.trOpenTitle")}
      >
        <td className="cs-c-exp">
          <button
            className="cs-exp-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            title={open ? t("centralStreaming.row.btnCloseTitle") : t("centralStreaming.row.btnOpenTitle")}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td className="go-fc-time go-mono">{fmtTime(ev.receivedAt)}</td>
        <td className="cs-c-stream">
          <span className={`cs-tag cs-tag-${ev.stream}`}>{STREAM_SHORT[ev.stream]}</span>
        </td>
        <td className="go-fc-cat">
          <span className="cs-typelabel" title={ev.type}>
            {ev.typeLabel}
          </span>
          {ev.category && <span className="cs-cat">{ev.category}</span>}
        </td>
        <td className="go-fc-site">
          {where ? <span className="go-site-name">{where}</span> : <span className="go-na">—</span>}
          {ev.deviceLabel && <span className="cs-dev go-mono">{ev.deviceLabel}</span>}
        </td>
        <td className="cs-summary">
          {ev.decodeError && <span className="cs-decode-bad" title={ev.decodeError}>!</span>}
          {ev.summary}
          {ev.actor && <span className="cs-actor">{t("centralStreaming.row.actor", { actor: ev.actor })}</span>}
        </td>
        <td className="go-fc-act">
          {onInvestigate && (
            <button
              className="go-investigate-btn"
              onClick={(e) => {
                e.stopPropagation();
                onInvestigate(buildStreamInvestigationQuery(ev));
              }}
              title={t("centralStreaming.row.investigateTitle")}
            >
              {t("centralStreaming.row.investigate")}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="cs-detail-row">
          <td colSpan={7}>
            <div className="cs-detail">
              <div className="cs-detail-meta go-mono">
                <span>{t("centralStreaming.row.cloudEventId", { id: ev.id })}</span>
                <span>{t("centralStreaming.row.type", { type: ev.type })}</span>
                {ev.eventAt && <span>{t("centralStreaming.row.eventAt", { time: fmtTime(ev.eventAt) })}</span>}
              </div>
              {ev.decodeError && <div className="go-src-err">{ev.decodeError}</div>}
              <pre className="cs-raw go-mono">{JSON.stringify(ev.payload, null, 2)}</pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
