// サイト詳細ページ(11 番で右スライドインのパネルとして作り、13 番で全画面に変更)。
// テーブル行 / 地図ピンのクリックで Global Overview 一覧と入れ替わる形で開く。
//
// 全画面にした理由(13 Task 1):
//   Health/SLE(Mist は 7 指標)・デバイス最大 9 台・クライアント十数件 × 7 列・
//   アラート・イベント最大 50 件を 560px 幅のパネルに縦積みしていたため、
//   クライアント表が横に潰れ、イベントを見るのに長いスクロールが必要だった。
//   ルーティングライブラリは入れず、既存のタブ切替と同じローカル state 方式で
//   「一覧」⇄「サイト詳細」を入れ替える(GlobalOverview.tsx 側で分岐)。
//
// データはオンデマンド取得(GET /api/global-overview/site-detail)。定期ポーリングとは別枠で、
// このページを開いた時だけ 1 サイトぶんを取りに行く。サーバ側が 30 秒キャッシュ + in-flight 共有で
// ガードするので、連続で開いても外部 API を叩き直さない。
//
// セクションの 3 状態(ok / error / unavailable)を UI でも分けて出す:
//   ok+0件      … 「なし」(グレー)。取得成功で 0 件、と欠損を混同しない
//   error       … 赤枠のインラインエラー(08 の共通パターンに準ずる。理由文を出す)
//   unavailable … 「このプラットフォームでは取得できません」(グレーの注記)

import { Fragment, useEffect, useRef, useState } from "react";
import { ALERT_DESC, ALERT_LABEL, PLATFORM_SHORT, type Platform, type SiteRow } from "./types";
import type {
  ClientDetailEnvelope,
  DetailAlert,
  DetailClient,
  DetailDevice,
  DetailEvent,
  DetailHealth,
  DetailSection,
  SectionStatus,
  SiteDetailEnvelope,
} from "./detailTypes";
import { fetchClientDetail, fetchSiteDetail } from "./api";
import { siteState, siteKey, STATE_COLOR, STATE_LABEL, PLATFORM_COLOR } from "./SiteMap";
import { buildInvestigationQuery } from "./investigate";
import { LogoBadge } from "../../network-investigation/view/LogoBadge";
import type { InvestigationRequest } from "../../../src/shell";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ja-JP", { hour12: false });
}

function fmtUptime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function healthClass(v: number | null): string {
  if (v === null) return "go-na";
  return v >= 80 ? "go-up" : v >= 50 ? "go-warn" : "go-down";
}

/** セクションの外枠。status に応じてエラー / 欠損 / 空を出し分ける。 */
function Section({
  title,
  count,
  note,
  status,
  error,
  emptyLabel = "なし",
  children,
}: {
  title: string;
  count?: number;
  note?: string;
  status: SectionStatus;
  error: string | null;
  emptyLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="go-dp-sec">
      <header className="go-dp-sec-head">
        <span className="go-dp-sec-title">{title}</span>
        {status === "ok" && count !== undefined && <span className="go-dp-sec-count">{count}</span>}
        {note && <span className="go-dp-sec-note">{note}</span>}
      </header>
      {status === "error" ? (
        <div className="go-dp-err">取得に失敗しました — {error}</div>
      ) : status === "unavailable" ? (
        <div className="go-dp-unavail">{note ?? "このプラットフォームでは取得できません"}</div>
      ) : count === 0 ? (
        <div className="go-dp-empty">{emptyLabel}</div>
      ) : (
        children
      )}
    </section>
  );
}

function HealthSection({ h }: { h: DetailHealth }) {
  return (
    <section className="go-dp-sec">
      <header className="go-dp-sec-head">
        <span className="go-dp-sec-title">Health / SLE</span>
        <span className="go-dp-sec-note">
          {h.source === "mist-sle" ? "Mist SLE(指標平均)" : h.source === "central-groups" ? "Central 健全性" : ""}
        </span>
      </header>
      {h.status === "error" ? (
        <div className="go-dp-err">取得に失敗しました — {h.error}</div>
      ) : (
        <div className="go-dp-health">
          <div className="go-dp-score">
            <span className={`go-dp-score-num ${healthClass(h.score)}`}>{h.score === null ? "—" : h.score}</span>
            <span className="go-dp-score-unit">/ 100</span>
          </div>
          <div className="go-dp-metrics">
            {h.metrics.length === 0 && <span className="go-dp-empty">内訳なし</span>}
            {h.metrics.map((m) => (
              <div className="go-dp-metric" key={m.label}>
                <span className="go-dp-metric-label">{m.label}</span>
                <span className="go-dp-metric-bar">
                  <span
                    className={`go-dp-metric-fill ${healthClass(m.value)}`}
                    style={{ width: `${m.value === null ? 0 : Math.max(2, Math.min(100, m.value))}%` }}
                  />
                </span>
                <span className={`go-dp-metric-val ${healthClass(m.value)}`}>
                  {m.value === null ? "—" : `${m.value}${m.unit ?? ""}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const KIND_LABEL: Record<DetailDevice["kind"], string> = {
  ap: "AP",
  switch: "Switch",
  gateway: "Gateway",
  other: "その他",
};

function DevicesSection({ sec, platform }: { sec: DetailSection<DetailDevice>; platform: string }) {
  const kinds: DetailDevice["kind"][] = ["ap", "switch", "gateway", "other"];
  const byKind = kinds
    .map((k) => ({ k, items: sec.items.filter((d) => d.kind === k) }))
    .filter((g) => g.items.length > 0);
  return (
    <Section title="デバイス" count={sec.items.length} status={sec.status} error={sec.error} emptyLabel="デバイスなし">
      <div className="go-dp-tbl-wrap">
        {byKind.map((g) => (
          <div key={g.k}>
            <div className="go-dp-kind-head">
              {KIND_LABEL[g.k]} <span className="go-dp-kind-n">{g.items.length}</span>
            </div>
            <table className="go-dp-tbl">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>モデル</th>
                  <th>状態</th>
                  <th>FW</th>
                  <th>稼働</th>
                  <th>IP</th>
                  {platform === "mist" && <th className="go-col-num">Cl</th>}
                </tr>
              </thead>
              <tbody>
                {g.items.map((d) => (
                  <tr key={d.id + d.mac}>
                    <td title={d.mac ?? d.id}>{d.name ?? d.mac ?? d.id}</td>
                    <td>{d.model ?? "—"}</td>
                    <td>
                      <span className="go-dp-dot" style={{ background: d.up ? STATE_COLOR.ok : STATE_COLOR.down }} />
                      {d.status ?? "—"}
                    </td>
                    <td className="go-mono">{d.firmware ?? "—"}</td>
                    <td>{fmtUptime(d.uptimeMs)}</td>
                    <td className="go-mono">{d.ip ?? "—"}</td>
                    {platform === "mist" && <td className="go-col-num">{d.numClients ?? "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * 接続クライアント一覧(Task 2)。行クリックでその 1 台のイベント履歴を
 * オンデマンド取得して展開する(Task 3。追加 HTTP はプラットフォームあたり 1 本)。
 */
function ClientsSection({
  sec,
  platform,
  siteId,
}: {
  sec: DetailSection<DetailClient>;
  platform: Platform;
  siteId: string;
}) {
  const [openMac, setOpenMac] = useState<string | null>(null);
  // mac → 取得状態(取得済みは detail、失敗は error)。同一 mac を再展開しても再取得しない。
  const [details, setDetails] = useState<Record<string, ClientDetailEnvelope>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingMac, setLoadingMac] = useState<string | null>(null);

  const toggle = (mac: string) => {
    if (openMac === mac) {
      setOpenMac(null);
      return;
    }
    setOpenMac(mac);
    if (details[mac] || errors[mac] || loadingMac === mac) return;
    setLoadingMac(mac);
    fetchClientDetail(platform, siteId, mac)
      .then((d) => setDetails((m) => ({ ...m, [mac]: d })))
      .catch((e) => setErrors((m) => ({ ...m, [mac]: e instanceof Error ? e.message : String(e) })))
      .finally(() => setLoadingMac((cur) => (cur === mac ? null : cur)));
  };

  const COLS = 7;
  return (
    <Section title="接続クライアント" count={sec.items.length} status={sec.status} error={sec.error} emptyLabel="接続クライアントなし">
      <div className="go-dp-tbl-wrap">
        <div className="go-dp-scroll">
          <table className="go-dp-tbl">
            <thead>
              <tr>
                <th>クライアント</th>
                <th>OS</th>
                <th>SSID</th>
                <th>帯域/CH</th>
                <th>SNR/RSSI</th>
                <th>IP</th>
                <th>接続先</th>
              </tr>
            </thead>
            <tbody>
              {sec.items.map((c) => {
                const open = openMac === c.mac;
                return (
                  <Fragment key={c.mac}>
                    <tr
                      className={`go-dp-crow${open ? " go-dp-crow-open" : ""}`}
                      onClick={() => toggle(c.mac)}
                      title="クリックでイベント履歴を表示"
                    >
                      <td title={c.mac}>
                        <span className={`go-dp-caret${open ? " go-dp-caret-open" : ""}`}>▸</span>
                        {c.name && c.name !== c.mac ? c.name : c.mac}
                        {c.vendor && <span className="go-dp-sub"> {c.vendor}</span>}
                      </td>
                      <td>{c.os ?? "—"}</td>
                      <td>{c.ssid ?? "—"}</td>
                      <td>
                        {c.band ?? "—"}
                        {c.channel !== null && <span className="go-dp-sub"> ch{c.channel}</span>}
                      </td>
                      <td className="go-mono">
                        {c.snr !== null ? `${c.snr}dB` : "—"}
                        {c.rssi !== null && <span className="go-dp-sub"> {c.rssi}dBm</span>}
                      </td>
                      <td className="go-mono">{c.ip ?? "—"}</td>
                      <td className="go-mono" title={c.connectedTo ?? ""}>{c.connectedTo ?? "—"}</td>
                    </tr>
                    {open && (
                      <tr className="go-dp-cdetail-row">
                        <td colSpan={COLS}>
                          <div className="go-dp-cdetail">
                            <div className="go-dp-cdetail-head">
                              イベント履歴 <span className="go-mono">{c.mac}</span>
                            </div>
                            {loadingMac === c.mac && <div className="go-dp-loading">取得中…</div>}
                            {errors[c.mac] && <div className="go-dp-err">取得に失敗しました — {errors[c.mac]}</div>}
                            {details[c.mac] && <ClientEvents sec={details[c.mac].events} />}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

/** クライアント展開時のイベント履歴(Task 3)。サイト Event と同じ描画を再利用。 */
function ClientEvents({ sec }: { sec: DetailSection<DetailEvent> }) {
  if (sec.status === "error") return <div className="go-dp-err">取得に失敗しました — {sec.error}</div>;
  if (sec.items.length === 0) return <div className="go-dp-empty">直近のイベントはありません{sec.note ? `(${sec.note})` : ""}</div>;
  return (
    <>
      {sec.note && <div className="go-dp-sec-note go-dp-cdetail-note">{sec.note}</div>}
      <EventList items={sec.items} />
    </>
  );
}

function sevClass(sev: string | null): string {
  const s = (sev ?? "").toLowerCase();
  if (s === "critical") return "go-dp-sev-crit";
  if (s === "major" || s === "warning" || s === "warn") return "go-dp-sev-warn";
  return "go-dp-sev-info";
}

function AlertsSection({
  sec,
  platform,
  siteName,
  onInvestigate,
}: {
  sec: DetailSection<DetailAlert>;
  platform: Platform;
  siteName: string;
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  return (
    <Section
      title="アラート"
      count={sec.items.length}
      note={sec.note ?? ALERT_LABEL[platform]}
      status={sec.status}
      error={sec.error}
      emptyLabel="アラートなし"
    >
      <ul className="go-dp-list">
        {sec.items.map((a, i) => (
          <li className="go-dp-item" key={a.id ?? i}>
            <span className={`go-dp-sev ${sevClass(a.severity)}`}>{a.severity ?? "—"}</span>
            <div className="go-dp-item-body">
              <div className="go-dp-item-title">{a.summary}</div>
              <div className="go-dp-item-meta">
                {a.category && <span>{a.category}</span>}
                {a.deviceLabel && <span>· {a.deviceLabel}</span>}
                <span>· {fmtTime(a.createdAt)}</span>
              </div>
            </div>
            {onInvestigate && (
              <button
                className="go-investigate-btn"
                title="この事案の要約をクエリ文にして、ネットワーク調査タブへ渡します(実行はされません)"
                onClick={() =>
                  onInvestigate(
                    buildInvestigationQuery({
                      siteName,
                      platform,
                      kind: "alert",
                      severity: a.severity,
                      category: a.category,
                      text: a.summary,
                      time: fmtTime(a.createdAt),
                    }),
                  )
                }
              >
                調査する
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** イベント severity(Central: negative/neutral/positive)をチップ色に割り当てる。 */
function evSevClass(sev: string | null): string {
  const s = (sev ?? "").toLowerCase();
  if (s === "negative") return "go-dp-evsev-neg";
  if (s === "positive") return "go-dp-evsev-pos";
  return "go-dp-evsev-neu";
}

/**
 * イベント一覧の描画(サイト Event / クライアント展開の両方で使う)。
 * 「調査する」(15番)はサイト直下の Event 一覧だけで出す。クライアント展開時の
 * イベント履歴は siteName/platform/onInvestigate を渡さず、従来どおりボタン無しにする。
 */
function EventList({
  items,
  siteName,
  platform,
  onInvestigate,
}: {
  items: DetailEvent[];
  siteName?: string;
  platform?: Platform;
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  return (
    <ul className="go-dp-list">
      {items.map((e, i) => (
        <li className="go-dp-item" key={i}>
          {e.severity ? (
            <span className={`go-dp-evsev ${evSevClass(e.severity)}`} title={e.severity}>
              {e.type ?? "event"}
            </span>
          ) : (
            <span className="go-dp-ev-type">{e.type ?? "event"}</span>
          )}
          <div className="go-dp-item-body">
            <div className="go-dp-item-title">{e.text}</div>
            <div className="go-dp-item-meta">
              {e.category && <span>{e.category}</span>}
              {e.deviceLabel && <span>· {e.deviceLabel}</span>}
              <span>· {fmtTime(e.timestamp)}</span>
            </div>
          </div>
          {onInvestigate && siteName && platform && (
            <button
              className="go-investigate-btn"
              title="この事案の要約をクエリ文にして、ネットワーク調査タブへ渡します(実行はされません)"
              onClick={() =>
                onInvestigate(
                  buildInvestigationQuery({
                    siteName,
                    platform,
                    kind: "event",
                    severity: e.severity,
                    category: e.category,
                    text: e.text,
                    time: fmtTime(e.timestamp),
                  }),
                )
              }
            >
              調査する
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function EventsSection({
  sec,
  platform,
  siteName,
  onInvestigate,
}: {
  sec: DetailSection<DetailEvent>;
  platform: Platform;
  siteName: string;
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  return (
    <Section
      title="イベント"
      count={sec.items.length}
      note={sec.note}
      status={sec.status}
      error={sec.error}
      emptyLabel="イベントなし"
    >
      <EventList items={sec.items} siteName={siteName} platform={platform} onInvestigate={onInvestigate} />
    </Section>
  );
}

export function SiteDetailPage({
  site,
  onBack,
  onInvestigate,
}: {
  site: SiteRow;
  onBack: () => void;
  /** 「調査する」ボタン押下時(15番)。ネットワーク調査タブへの切り替えは呼び出し側が行う */
  onInvestigate?: (req: InvestigationRequest) => void;
}) {
  const [detail, setDetail] = useState<SiteDetailEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reqSeq = useRef(0);

  const st = siteState(site);

  useEffect(() => {
    // Esc で一覧に戻る(11 番のパネル時代と同じキー操作を残す)。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // サイトを切り替えて開き直したとき、前のサイトのスクロール位置を引き継がない。
  useEffect(() => {
    document.querySelector(".go-sd-root")?.scrollTo({ top: 0 });
  }, [site.platform, site.siteId]);

  useEffect(() => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    if (!site.siteId) {
      setLoading(false);
      setError("このサイトには siteId が無いため詳細を取得できません(未割り当てデバイス等)。");
      return;
    }
    fetchSiteDetail(site.platform, site.siteId, site.siteName)
      .then((d) => {
        if (reqSeq.current !== seq) return;
        setDetail(d);
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (reqSeq.current === seq) setLoading(false);
      });
  }, [site.platform, site.siteId, site.siteName]);

  return (
    <div className="go-root go-sd-root">
      <header className="go-sd-head">
        <button className="go-sd-back" onClick={onBack} title="Global Overview の一覧に戻る (Esc)">
          ← 一覧に戻る
        </button>
        <span
          className="go-dp-dot go-dp-dot-lg"
          style={{ background: STATE_COLOR[st], borderColor: PLATFORM_COLOR[site.platform] }}
          title={STATE_LABEL[st]}
        />
        <div className="go-dp-head-main">
          <div className="go-sd-title">{site.siteName}</div>
          <div className="go-dp-head-sub">
            <LogoBadge target={site.platform} size={14} />
            <span>{PLATFORM_SHORT[site.platform]}</span>
            <span className="go-dp-sep">·</span>
            <span>{STATE_LABEL[st]}</span>
            <span className="go-dp-sep">·</span>
            <span>デバイス {site.deviceUp}/{site.deviceTotal}</span>
            <span className="go-dp-sep">·</span>
            <span>クライアント {site.clients}</span>
            <span className="go-dp-sep">·</span>
            <span title={ALERT_DESC[site.platform]}>
              アラート {site.alerts}
              <span className="go-alert-tag">{ALERT_LABEL[site.platform]}</span>
            </span>
          </div>
        </div>
        {detail && !loading && (
          <div className="go-sd-fetched go-mono">
            取得 {fmtTime(detail.fetchedAt)}
            {detail.cached ? "(キャッシュ)" : ` · HTTP ${detail.requests} 本`}
          </div>
        )}
      </header>

      {loading && <div className="go-dp-loading">詳細を取得中…</div>}
      {error && !loading && <div className="go-dp-err go-dp-err-top">{error}</div>}

      {detail && !loading && (
        <div className="go-sd-grid">
          {/* 上段は左右 2 枚。Health(Mist は 7 指標)とデバイス(最大 9 台)は高さが近い。 */}
          <div className="go-sd-card">
            <HealthSection h={detail.health} />
          </div>
          <div className="go-sd-card">
            <DevicesSection sec={detail.devices} platform={detail.platform} />
          </div>
          {/* クライアント表は 7 列あるので横幅を全部使う(パネル時代に潰れていた箇所)。 */}
          <div className="go-sd-card go-sd-wide">
            <ClientsSection sec={detail.clients} platform={detail.platform} siteId={detail.siteId} />
          </div>
          <div className="go-sd-card">
            <AlertsSection
              sec={detail.alerts}
              platform={detail.platform}
              siteName={detail.siteName}
              onInvestigate={onInvestigate}
            />
          </div>
          <div className="go-sd-card">
            <EventsSection
              sec={detail.events}
              platform={detail.platform}
              siteName={detail.siteName}
              onInvestigate={onInvestigate}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export { siteKey };
