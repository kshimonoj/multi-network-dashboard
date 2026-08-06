// タグ付き Client / Device タブ(59)。
//
// 画面構成:
//   ヘッダ … Client ⇔ Device のサブビュー切替(ベストプラクティス診断タブの
//            「診断」⇔「ルール一覧」と同じパターン)+ 更新ボタン
//   一覧   … タグが付いた対象**だけ**を出す。見つからない対象も灰色で残す(57 §3-5)
//   詳細   … 行を開くと Central 用 / Mist 用のビューを出す(58 §2-2 の分離設計)
//
// タグは**このダッシュボード固有のローカル機能**で、Central / Mist の設定には触れない。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime, formatRelative, useT, type TFunc } from "../../../src/i18n";
import {
  fetchClientDetail,
  fetchClientList,
  fetchDeviceDetail,
  fetchDeviceList,
  fetchStatus,
  fetchTagStore,
  searchTargets,
} from "./api";
import { ClientDetailPanel } from "./ClientDetail";
import { DeviceDetailPanel } from "./DeviceDetail";
import { AddTargetPanel, TagAssigner, TagManager, removeTarget } from "./TagControls";
import { centralLastSeen, formatUptime, statusKind, toColonMac } from "./format";
import { SignalBadge, formatBps } from "./primitives";
import type {
  ClientDetail,
  ClientListResponse,
  ClientSummary,
  DetailEnvelope,
  DeviceDetail,
  DeviceListResponse,
  DeviceSummary,
  ListEnvelope,
  StatusResponse,
  TagStoreFile,
  TaggedRow,
  TargetKind,
} from "./types";
import "../../global-overview/view/styles.css";
import "./styles.css";

interface Props {
  active: boolean;
}

export function TaggedTargets({ active }: Props) {
  const t = useT();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [view, setView] = useState<TargetKind>("client");
  const [store, setStore] = useState<TagStoreFile | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTags, setShowTags] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const [clients, setClients] = useState<ClientListResponse | null>(null);
  const [devices, setDevices] = useState<DeviceListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const loadStore = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([fetchTagStore(), fetchStatus()]);
      if (!mounted.current) return;
      setStore(s);
      setStatus(st);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadList = useCallback(
    async (kind: TargetKind, force: boolean) => {
      setLoading(true);
      try {
        if (kind === "client") {
          const r = await fetchClientList(force);
          if (mounted.current) setClients(r);
        } else {
          const r = await fetchDeviceList(force);
          if (mounted.current) setDevices(r);
        }
        if (mounted.current) setError(null);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [],
  );

  // タブを開いたとき・サブビューを切り替えたときに必要なぶんだけ読む。
  useEffect(() => {
    if (!active) return;
    if (store === null) void loadStore();
    void loadList(view, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view]);

  const onStore = useCallback(
    (s: TagStoreFile) => {
      setStore(s);
      // タグ / 対象が変わったらサーバ側のキャッシュも捨てられているので取り直す。
      void loadList(view, false);
    },
    [loadList, view],
  );

  const tags = store?.tags ?? [];
  const list: ListEnvelope<ClientSummary | DeviceSummary> | null =
    view === "client" ? clients : devices;

  const refresh = useCallback(() => {
    void loadStore();
    void loadList(view, true);
  }, [loadStore, loadList, view]);

  return (
    <div className="go-root tt-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("taggedTargets.title")}</h1>
          <span className="go-head-sub">{t("taggedTargets.headerSub")}</span>
        </div>
        <div className="bp-view-toggle" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "client"}
            className={`bp-view-btn${view === "client" ? " active" : ""}`}
            onClick={() => {
              setView("client");
              setOpenKey(null);
            }}
          >
            {t("taggedTargets.view.client")}
            {status && <span className="tt-count">{status.counts.clients}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "device"}
            className={`bp-view-btn${view === "device" ? " active" : ""}`}
            onClick={() => {
              setView("device");
              setOpenKey(null);
            }}
          >
            {t("taggedTargets.view.device")}
            {status && <span className="tt-count">{status.counts.devices}</span>}
          </button>
        </div>
      </div>

      <div className="tt-controls">
        <button className="go-refresh" onClick={() => setShowAdd((v) => !v)}>
          {t(`taggedTargets.add.open.${view}`)}
        </button>
        <button className="go-refresh bp-btn-secondary" onClick={() => setShowTags((v) => !v)}>
          {t("taggedTargets.tag.manage")}
        </button>
        <button className="go-refresh bp-btn-secondary" onClick={refresh} disabled={loading}>
          {t("taggedTargets.refresh")}
        </button>
        {list && (
          <span className="go-updated">
            <span className="go-updated-label">{t("taggedTargets.fetchedAt")}: </span>
            <span className="go-updated-value go-mono">{formatDateTime(list.fetchedAt)}</span>
            {list.cached && (
              <span className="go-updated-age">
                {t("taggedTargets.cached", { age: formatRelative(t, list.ageMs) })}
              </span>
            )}
          </span>
        )}
      </div>

      {error && <div className="go-error">{error}</div>}
      {status && !status.configured.central && !status.configured.mist && (
        <div className="go-note go-note-warn">{t("taggedTargets.noCredentials")}</div>
      )}
      <SourceNotes t={t} list={list} />

      {showAdd && store && (
        <AddTargetPanel
          kind={view}
          tags={tags}
          onStore={onStore}
          onError={setError}
          onClose={() => setShowAdd(false)}
          search={searchTargets}
        />
      )}

      {showTags && store && (
        <div className="go-panel tt-panel">
          <div className="go-panel-head">
            <span className="go-panel-title">{t("taggedTargets.tag.manage")}</span>
            <span className="go-panel-note">{t("taggedTargets.tag.localOnly")}</span>
          </div>
          <div className="tt-panel-body">
            <TagManager store={store} onStore={onStore} onError={setError} />
          </div>
        </div>
      )}

      {loading && !list && <div className="go-loading">{t("taggedTargets.loading")}</div>}

      {list && list.rows.length === 0 && (
        <div className="go-note">{t(`taggedTargets.empty.${view}`)}</div>
      )}

      {list && list.rows.length > 0 && (
        <div className="go-panel tt-panel">
          <div className="go-table-scroll">
            <table className="go-table tt-table tt-list">
              <thead>
                {view === "client" ? (
                  <tr>
                    <th />
                    <th>{t("taggedTargets.col.target")}</th>
                    <th>{t("taggedTargets.col.tags")}</th>
                    <th>{t("taggedTargets.col.platform")}</th>
                    <th>{t("taggedTargets.col.site")}</th>
                    <th>{t("taggedTargets.col.state")}</th>
                    <th>{t("taggedTargets.col.connectedTo")}</th>
                    <th>{t("taggedTargets.col.quality")}</th>
                    <th />
                  </tr>
                ) : (
                  <tr>
                    <th />
                    <th>{t("taggedTargets.col.target")}</th>
                    <th>{t("taggedTargets.col.tags")}</th>
                    <th>{t("taggedTargets.col.platform")}</th>
                    <th>{t("taggedTargets.col.site")}</th>
                    <th>{t("taggedTargets.col.state")}</th>
                    <th>{t("taggedTargets.col.model")}</th>
                    <th>{t("taggedTargets.col.uptime")}</th>
                    <th />
                  </tr>
                )}
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <Row
                    key={`${row.assignment.kind}:${row.assignment.key}`}
                    t={t}
                    row={row}
                    tags={tags}
                    open={openKey === row.assignment.key}
                    onToggle={() =>
                      setOpenKey((k) => (k === row.assignment.key ? null : row.assignment.key))
                    }
                    onStore={onStore}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** プラットフォームごとの取得結果。片方が落ちても他方は出しているので、理由をここに出す。 */
function SourceNotes({
  t,
  list,
}: {
  t: TFunc;
  list: ListEnvelope<ClientSummary | DeviceSummary> | null;
}) {
  if (!list) return null;
  const failed = list.sources.filter((s) => !s.ok);
  return (
    <>
      {failed.map((s) => (
        <div key={s.platform} className="go-inline-error">
          {s.error === "not-configured"
            ? t("taggedTargets.source.notConfigured", { platform: t(`taggedTargets.platform.${s.platform}`) })
            : t("taggedTargets.source.failed", {
                platform: t(`taggedTargets.platform.${s.platform}`),
                error: s.error ?? "",
              })}
        </div>
      ))}
      {list.truncated.map((code) => {
        const n = code.split(":")[1] ?? "?";
        return (
          <div key={code} className="go-note go-note-warn">
            {t("taggedTargets.truncated.mistSites", { n })}
          </div>
        );
      })}
    </>
  );
}

function Row({
  t,
  row,
  tags,
  open,
  onToggle,
  onStore,
  onError,
}: {
  t: TFunc;
  row: TaggedRow<ClientSummary | DeviceSummary>;
  tags: import("./types").TagDef[];
  open: boolean;
  onToggle: () => void;
  onStore: (s: TagStoreFile) => void;
  onError: (m: string) => void;
}) {
  const { assignment, matches } = row;
  const found = matches.length > 0;
  const m = matches[0] ?? null;
  const isClient = assignment.kind === "client";
  const macText = toColonMac(assignment.key);
  const rawLabel = assignment.label ?? labelOf(m);
  // 覚え書き / 実データの名前が MAC の別表記だった場合も「同じ」とみなす
  const displayLabel =
    rawLabel && rawLabel.toLowerCase().replace(/[^0-9a-f]/g, "") !== assignment.key
      ? rawLabel
      : macText;

  return (
    <>
      <tr className={`tt-row${found ? "" : " tt-row-missing"}`}>
        <td className="tt-row-toggle">
          <button type="button" className="tt-expand" onClick={onToggle} aria-expanded={open}>
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td>
          <div className="tt-target-cell">
            <span className="tt-target-label">{displayLabel}</span>
            {/* 名前が MAC そのものの端末が多い(58 §2-4)。同じ文字列を 2 行出さない */}
            {displayLabel !== macText && <span className="go-panel-note">{macText}</span>}
            {assignment.serial && <span className="go-panel-note">{assignment.serial}</span>}
            {assignment.randomMac && (
              <span className="tt-random-badge" title={t("taggedTargets.randomMac.rowTooltip")}>
                {t("taggedTargets.randomMac.badge")}
              </span>
            )}
          </div>
        </td>
        <td>
          <TagAssigner assignment={assignment} tags={tags} onStore={onStore} onError={onError} />
        </td>
        <td>
          {m ? (
            <span className={`tt-plat tt-plat-${m.platform}`}>
              {t(`taggedTargets.platform.${m.platform}`)}
            </span>
          ) : (
            <span className="go-zero">—</span>
          )}
        </td>
        <td>{m ? (siteOf(m) ?? "—") : (assignment.lastSeen?.siteName ?? "—")}</td>
        <td>{found ? stateCell(t, m!) : <MissingState t={t} row={row} />}</td>
        {isClient ? (
          <>
            <td>{m ? (connectedToOf(m as ClientSummary) ?? "—") : "—"}</td>
            <td>{m ? qualityCell(m as ClientSummary) : "—"}</td>
          </>
        ) : (
          <>
            <td>{m ? (modelOf(m as DeviceSummary) ?? "—") : "—"}</td>
            <td>{m ? (uptimeOf(m as DeviceSummary) ?? "—") : "—"}</td>
          </>
        )}
        <td>
          <button
            type="button"
            className="tt-danger-btn"
            onClick={() => void removeTarget(t, assignment, onStore, onError)}
            title={t("taggedTargets.target.removeTitle")}
          >
            {t("taggedTargets.target.remove")}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="tt-detail-row">
          <td colSpan={9}>
            <DetailLoader kind={assignment.kind} targetKey={assignment.key} t={t} row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function MissingState({ t, row }: { t: TFunc; row: TaggedRow<ClientSummary | DeviceSummary> }) {
  const at = row.assignment.lastSeen?.at;
  return (
    <span className="go-zero" title={at ? formatDateTime(at) : undefined}>
      {t("taggedTargets.presence.notFound")}
    </span>
  );
}

// ---- セルの中身。**型ごとに分岐する**(共通の抽象に潰さない) ----

function labelOf(m: ClientSummary | DeviceSummary | null): string | null {
  if (!m) return null;
  if (m.platform === "central") {
    return "clientName" in m ? (m.clientName ?? m.hostName) : m.deviceName;
  }
  return "hostname" in m ? m.hostname : m.name;
}

function siteOf(m: ClientSummary | DeviceSummary): string | null {
  return m.siteName;
}

function stateCell(t: TFunc, m: ClientSummary | DeviceSummary): JSX.Element {
  if (m.platform === "central") {
    // Central のクライアントは lastSeenAt が "0" のとき接続中(58 §1-8-1 / §4 #5)
    if ("lastSeenAtRaw" in m) {
      const ls = centralLastSeen(m.lastSeenAtRaw);
      const label = ls.mode === "connected" ? t("taggedTargets.presence.connected") : (m.status ?? "—");
      return <span className={statusKind(m.status) === "up" ? "go-up" : undefined}>{label}</span>;
    }
    return (
      <span className={statusKind(m.status) === "up" ? "go-up" : statusKind(m.status) === "down" ? "go-down" : undefined}>
        {m.status ?? "—"}
      </span>
    );
  }
  if ("connected" in m) {
    return (
      <span className={m.connected ? "go-up" : "go-zero"}>
        {m.connected
          ? t("taggedTargets.presence.connected")
          : m.lastSeen
            ? t("taggedTargets.presence.lastSeenAt", { at: formatDateTime(m.lastSeen) })
            : t("taggedTargets.presence.notConnected")}
      </span>
    );
  }
  return (
    <span className={statusKind(m.status) === "up" ? "go-up" : statusKind(m.status) === "down" ? "go-down" : undefined}>
      {m.status ?? "—"}
    </span>
  );
}

function connectedToOf(m: ClientSummary): string | null {
  if (m.platform === "central") return m.connectedTo;
  return m.connectionType === "wired"
    ? (m.deviceMac ? `${toColonMac(m.deviceMac)}${m.portId ? ` / ${m.portId}` : ""}` : null)
    : m.ssid;
}

function qualityCell(m: ClientSummary): JSX.Element {
  // Central は SNR のみ、Mist は RSSI + SNR。**Central に RSSI 欄を作らない**(58 §2-4)
  if (m.platform === "central") {
    return m.snr !== null ? <SignalBadge kind="snr" value={m.snr} /> : <span className="go-zero">—</span>;
  }
  if (m.rssi === null && m.snr === null) {
    return (
      <span className="go-zero">
        {m.txBps !== null || m.rxBps !== null ? `${formatBps(m.txBps)} / ${formatBps(m.rxBps)}` : "—"}
      </span>
    );
  }
  return (
    <span className="tt-quality-cell">
      {m.rssi !== null && <SignalBadge kind="rssi" value={m.rssi} />}
      {m.snr !== null && <SignalBadge kind="snr" value={m.snr} />}
    </span>
  );
}

function modelOf(m: DeviceSummary): string | null {
  return m.model;
}

function uptimeOf(m: DeviceSummary): string | null {
  return m.platform === "central"
    ? m.uptimeMs === null
      ? null
      : formatUptime(Math.floor(m.uptimeMs / 1000))
    : formatUptime(m.uptimeSec);
}

// ---- 詳細の遅延読み込み ----

function DetailLoader({
  kind,
  targetKey,
  t,
  row,
}: {
  kind: TargetKind;
  targetKey: string;
  t: TFunc;
  row: TaggedRow<ClientSummary | DeviceSummary>;
}) {
  const [env, setEnv] = useState<DetailEnvelope<ClientDetail | DeviceDetail> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setErr(null);
      try {
        const r =
          kind === "client"
            ? await fetchClientDetail(targetKey, force)
            : await fetchDeviceDetail(targetKey, force);
        setEnv(r as DetailEnvelope<ClientDetail | DeviceDetail>);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [kind, targetKey],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const failed = useMemo(() => (env?.sources ?? []).filter((s) => !s.ok), [env]);

  return (
    <div className="tt-detail-wrap">
      <div className="tt-detail-actions">
        <button className="go-refresh bp-btn-secondary" onClick={() => void load(true)} disabled={busy}>
          {t("taggedTargets.detail.refresh")}
        </button>
        {env?.cached && (
          <span className="go-panel-note">
            {t("taggedTargets.cached", { age: formatRelative(t, env.ageMs) })}
          </span>
        )}
      </div>

      {busy && !env && <div className="go-loading">{t("taggedTargets.detail.loading")}</div>}
      {err && <div className="go-error">{err}</div>}
      {failed.map((s) => (
        <div key={s.platform} className="go-inline-error">
          {t("taggedTargets.source.failed", {
            platform: t(`taggedTargets.platform.${s.platform}`),
            error: s.error ?? "",
          })}
        </div>
      ))}

      {env && env.details.length === 0 && !busy && (
        <div className="go-note">
          {t("taggedTargets.detail.notFound")}
          {row.assignment.lastSeen?.siteName && (
            <>
              {" "}
              {t("taggedTargets.detail.lastSeenHint", {
                site: row.assignment.lastSeen.siteName,
                at: row.assignment.lastSeen.at ? formatDateTime(row.assignment.lastSeen.at) : "—",
              })}
            </>
          )}
        </div>
      )}

      {/* 両方から返った場合はカードを縦に 2 枚並べる(マージしない。58 §2-6) */}
      {env?.details.map((d, i) =>
        kind === "client" ? (
          <ClientDetailPanel key={`${d.platform}-${i}`} detail={d as ClientDetail} />
        ) : (
          <DeviceDetailPanel key={`${d.platform}-${i}`} detail={d as DeviceDetail} />
        ),
      )}
    </div>
  );
}
