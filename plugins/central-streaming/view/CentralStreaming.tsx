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
  STATE_LABEL,
  STREAM_SHORT,
  VOLUME_LABEL,
  type StreamEndpointDef,
  type StreamEnvelope,
  type StreamEvent,
  type StreamKey,
  type StreamSettings,
  type StreamStatus,
} from "./types";
import { buildStreamInvestigationQuery } from "./investigate";
import type { InvestigationRequest } from "../../../src/shell";
import "../../global-overview/view/styles.css";
import "./styles.css";

/** 一度に描画する行数。 */
const PAGE_SIZE = 200;
/** 画面を開いているあいだ、サーバの状態を読み直す間隔。 */
const VIEW_POLL_MS = 5_000;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ja-JP", { hour12: false });
}

function fmtAge(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 時間前` : `${Math.floor(h / 24)} 日前`;
}

function fmtCountdown(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((t - now) / 1000));
  return s < 60 ? `${s} 秒後` : `${Math.floor(s / 60)} 分後`;
}

export function CentralStreaming({
  active,
  onInvestigate,
}: {
  active: boolean;
  /** 「調査する」ボタン押下時。タブ切り替えは呼び出し側(main.tsx)が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
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
          <h1 className="go-h1">Streaming(Central)</h1>
          <span className="go-head-sub">
            New Central Streaming API — WSS 常時接続 / CloudEvents + protobuf 二段デコード
          </span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">保存済み</span>
            <span className="go-updated-value">{env?.stored ?? 0} 件</span>
            <span className="go-updated-age">(更新 {fmtAge(env?.generatedAt ?? null, now)})</span>
          </div>
          <button
            className={`cs-master${settings?.enabled ? " cs-master-on" : ""}`}
            onClick={onToggleAll}
            disabled={busy || !settings || !env?.configured}
            title={
              settings?.enabled
                ? "すべてのストリームを切断します(設定は保持されます)"
                : "選択済みのストリームへ WSS 接続を開始します"
            }
          >
            <span className="cs-master-dot" aria-hidden />
            {settings?.enabled ? "受信中 — 停止する" : "停止中 — 開始する"}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {env && !env.configured && env.configError && (
        <div className="go-error">Streaming API に接続できません: {env.configError}</div>
      )}
      {!env && <div className="go-loading">接続状態を読み込み中…</div>}

      {env && settings && (
        <>
          {/* 接続状態 + ストリームごとのトグル(二段階 UI の 1 段目) */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">接続状態</span>
              <span className="go-panel-note">
                全体トグルが「停止中」のあいだは、個別に選んでいても接続しません
              </span>
            </header>
            <div className="cs-conns">
              {env.streams.map((s) => (
                <ConnCard
                  key={s.key}
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
              def={catalogOf(editing)}
              selected={settings.streams[editing].eventTypes}
              busy={busy}
              onToggleType={(id) => onToggleType(editing, id)}
              onSelectAll={() => onSetAllTypes(editing, catalogOf(editing)?.eventTypes.map((t) => t.id) ?? [])}
              onSelectNone={() => onSetAllTypes(editing, [])}
              onClose={() => setEditing(null)}
            />
          )}

          {/* Retention */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">保存と Retention</span>
              <span className="go-panel-note">
                保存先 data/central-streaming/events.jsonl · 保持 {env.stored} 件
                {env.lastPurgeAt
                  ? ` · 最終削除 ${fmtTime(env.lastPurgeAt)}(${env.lastPurged} 件)`
                  : " · まだ削除は走っていません"}
              </span>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">保持期間</span>
                <select
                  className="go-fsel"
                  value={settings.retentionDays}
                  disabled={busy}
                  onChange={(e) => void save({ retentionDays: Number(e.target.value) })}
                  title="この日数より古いイベントは定期ジョブ(10 分ごと)で削除されます"
                >
                  {env.retentionOptionsDays.map((d) => (
                    <option key={d} value={d}>
                      {d} 日
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">保持件数</span>
                <select
                  className="go-fsel"
                  value={settings.maxEvents}
                  disabled={busy}
                  onChange={(e) => void save({ maxEvents: Number(e.target.value) })}
                  title="保持期間より先にこちらの上限に当たった場合は、古いものから捨てられます"
                >
                  {env.maxEventsOptions.map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString("ja-JP")} 件
                    </option>
                  ))}
                </select>
              </div>
              <div className="go-fgroup">
                <button
                  className="go-chip"
                  disabled={busy}
                  onClick={() => void purgeStreamEvents().then(() => load())}
                  title="Retention の判定を今すぐ実行します"
                >
                  今すぐ整理
                </button>
                <button
                  className="go-chip"
                  disabled={busy}
                  onClick={() => void clearStreamEvents().then(() => load())}
                  title="保存済みイベントをすべて削除します(設定は消えません)"
                >
                  すべて削除
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <span className="go-foot-hint">
                  Location / RSSI は秒あたり数件が流れ続けます。長時間有効にする場合は保持件数を確認してください。
                </span>
              </div>
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">フィルタ</span>
              <span className="go-panel-note">
                {filtered.length} / {items.length} 件(表示は最新 {items.length} 件まで)
              </span>
              <button
                className="go-chip"
                onClick={() => {
                  setStreamFilter("all");
                  setQ("");
                  setErrorsOnly(false);
                }}
              >
                クリア
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">ストリーム</span>
                <button
                  className={`go-chip${streamFilter === "all" ? " go-chip-on" : ""}`}
                  onClick={() => setStreamFilter("all")}
                >
                  すべて
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
                  title="protobuf のデコードに失敗した行だけを表示します"
                >
                  デコード失敗のみ
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <input
                  className="go-fsearch"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="要約 / 種別 / デバイス / サイト / 実行者で絞り込み"
                />
              </div>
            </div>
          </section>

          {/* タイムライン */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">受信イベント</span>
              <span className="go-panel-note">
                受信の新しい順 · {shown.length} / {filtered.length} 件を表示
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table cs-table">
                <thead>
                  <tr>
                    <th className="cs-c-exp" aria-label="展開" />
                    <th className="go-fc-time">受信時刻</th>
                    <th className="cs-c-stream">ストリーム</th>
                    <th className="go-fc-cat">種別</th>
                    <th className="go-fc-site">サイト / デバイス</th>
                    <th>内容</th>
                    <th className="go-fc-act" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((ev) => (
                    <Row
                      key={ev.id}
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
                          ? "まだイベントを受信していません(接続状態を確認してください)"
                          : "受信は停止中です。上の「開始する」で購読を始めてください"}
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

      <div className="go-foot go-mono">
        接続は<b>サーバ側</b>が保持します(ブラウザから Central へは繋ぎません)。
        アクセストークンは有効期限の 5 分前に取り直して張り直し、予期しない切断時は指数バックオフ
        (最大 60 秒)で再接続します。Central は切断後 15 分間イベントをキューするため、
        その範囲で復帰すれば取りこぼしません。
        {env?.streams.find((s) => s.tokenExpiresAt)?.tokenExpiresAt && (
          <> / 現在のトークン期限 {fmtTime(env.streams.find((s) => s.tokenExpiresAt)!.tokenExpiresAt)}</>
        )}
        {" / "}自動調査は実装していません(各イベントに重要度に相当するフィールドが無いため)。
      </div>
    </div>
  );
}

// ---- ストリーム 1 件のカード ----

function ConnCard({
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
          <span className="cs-conn-label">{status.label}</span>
        </label>
        <span className={`cs-badge cs-badge-${status.state}`}>{STATE_LABEL[status.state]}</span>
      </div>
      <div className="cs-conn-meta go-mono">
        <span>受信 {status.received.toLocaleString("ja-JP")} 件</span>
        <span>最終 {fmtAge(status.lastEventAt, now)}</span>
        {def && <span className={`cs-vol cs-vol-${def.volume}`}>{VOLUME_LABEL[def.volume]}</span>}
      </div>
      <div className="cs-conn-types">
        {selectedCount === 0 ? `全イベント(${total} 種別すべて)` : `${selectedCount} / ${total} 種別を選択`}
        <button className="go-chip cs-edit" onClick={onEdit} disabled={busy}>
          {editing ? "閉じる" : "種別を選ぶ"}
        </button>
      </div>
      {status.state === "reconnecting" && status.nextRetryAt && (
        <div className="cs-conn-note">次の再接続: {fmtCountdown(status.nextRetryAt, now)}</div>
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
          title="意図的に切断して、再接続ロジックが働くことを確認します"
        >
          切断テスト
        </button>
      )}
    </div>
  );
}

// ---- イベント種別の選択(二段階 UI の 2 段目) ----

function TypePicker({
  def,
  selected,
  busy,
  onToggleType,
  onSelectAll,
  onSelectNone,
  onClose,
}: {
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
        <span className="go-panel-title">{def.label} — 購読するイベント種別</span>
        <span className="go-panel-note">
          何も選ばない = そのエンドポイントの全イベントを受け取る(event-types を付けない)
        </span>
        <button className="go-chip" onClick={onSelectNone} disabled={busy}>
          全解除(= 全イベント)
        </button>
        <button className="go-chip" onClick={onSelectAll} disabled={busy}>
          すべて選択
        </button>
        <button className="go-chip" onClick={onClose}>
          閉じる
        </button>
      </header>
      <div className="cs-picker-note">{def.note}</div>
      <div className="cs-types">
        {def.eventTypes.map((t) => (
          <label key={t.id} className={`cs-type${sel.has(t.id) ? " cs-type-on" : ""}`} title={t.id}>
            <input
              type="checkbox"
              checked={sel.has(t.id)}
              disabled={busy}
              onChange={() => onToggleType(t.id)}
            />
            <span className="cs-type-label">{t.label}</span>
            <span className="cs-type-msg go-mono">{t.message.split(".").pop()}</span>
          </label>
        ))}
      </div>
      <div className="cs-picker-foot go-mono">
        wss://&lt;Central&gt;/{def.path} · proto: {def.protoFile}
      </div>
    </section>
  );
}

// ---- タイムラインの 1 行 ----

function Row({
  ev,
  open,
  onToggle,
  onInvestigate,
}: {
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
        title={open ? "クリックで閉じる" : "クリックでデコード結果(生データ)を表示する"}
      >
        <td className="cs-c-exp">
          <button
            className="cs-exp-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            title={open ? "閉じる" : "デコード結果を表示する"}
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
          {ev.actor && <span className="cs-actor">実行者 {ev.actor}</span>}
        </td>
        <td className="go-fc-act">
          {onInvestigate && (
            <button
              className="go-investigate-btn"
              onClick={(e) => {
                e.stopPropagation();
                onInvestigate(buildStreamInvestigationQuery(ev));
              }}
              title="このイベントを題材にネットワーク調査タブでクエリを組み立てます(自動実行はしません)"
            >
              調査する
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="cs-detail-row">
          <td colSpan={7}>
            <div className="cs-detail">
              <div className="cs-detail-meta go-mono">
                <span>CloudEvent id: {ev.id}</span>
                <span>type: {ev.type}</span>
                {ev.eventAt && <span>発生時刻: {fmtTime(ev.eventAt)}</span>}
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
