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
  updateWebhookPollInterval,
} from "./api";
import {
  SEVERITY_LABEL,
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
import "../../global-overview/view/styles.css";
import "./styles.css";

/** 一度に描画する行数。MistLog は数百行あるので既定は先頭ぶんだけ出す。 */
const PAGE_SIZE = 200;

/** 画面を開いているあいだ、サーバのキャッシュをこの間隔で読み直す(外部 API は叩かれない)。 */
const VIEW_POLL_MS = 15_000;

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

function fmtInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 時間`;
  if (ms % 60000 === 0) return `${ms / 60000} 分`;
  return `${Math.round(ms / 1000)} 秒`;
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
  const [feed, setFeed] = useState<WebhookFeedEnvelope | null>(null);
  const [settings, setSettings] = useState<WebhookPollSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
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
          <h1 className="go-h1">Webhook ログ</h1>
          <span className="go-head-sub">
            New Central / Classic Central / Mist — Google スプレッドシート
            {feed?.spreadsheetTitle ? `「${feed.spreadsheetTitle}」` : ""}経由
          </span>
        </div>
        <div className="go-head-meta">
          <div className="go-updated">
            <span className="go-updated-label">最終取得</span>
            <span className="go-updated-value">{fmtTime(feed?.generatedAt ?? null)}</span>
            <span className="go-updated-age">({fmtAge(ageMs)})</span>
            {feed?.stale && <span className="go-tag go-tag-dim">次の巡回待ち</span>}
          </div>
          <button
            className="go-refresh"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            title={`スプレッドシートから新規行を取り直します(最短間隔 ${Math.round(
              (feed?.minRefreshMs ?? 30000) / 1000,
            )} 秒)`}
          >
            {refreshing ? "取得中…" : "更新"}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{error}</div>}
      {feed && !feed.configured && feed.configError && (
        <div className="go-error">
          Webhook ログを取得できません: {feed.configError}
        </div>
      )}
      {loading && !feed && <div className="go-loading">Webhook ログを読み込み中…</div>}

      {feed && (
        <>
          {/* 取得元シートごとの読み取り位置と成否 */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">取得元シート</span>
              <span className="go-panel-note">全 {items.length} 件</span>
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
                      <span className="go-tag go-tag-bad">失敗</span>
                    )}
                    <span className="go-src-req go-mono">
                      読取済み {Math.max(0, s.lastRow - 1)} 行
                      {s.newRows > 0 ? ` (前回 +${s.newRows})` : ""}
                    </span>
                  </div>
                  <div className="go-src-note">
                    差分取得: 次回は {s.lastRow + 1} 行目から読みます
                  </div>
                  {s.error && <div className="go-src-err">{s.error}</div>}
                </div>
              ))}
            </div>
          </section>

          {/* フィルタ */}
          <section className="go-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">フィルタ</span>
              <span className="go-panel-note">
                {filtered.length} / {items.length} 件(重大 {counts.critical} · 警告 {counts.warning} ·
                自動調査あり {counts.auto})
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
                title="すべてのフィルタを解除する"
              >
                クリア
              </button>
            </header>
            <div className="go-fbar">
              <div className="go-fgroup">
                <span className="go-flabel">ソース</span>
                {(["all", ...SOURCE_ORDER] as const).map((s) => (
                  <button
                    key={s}
                    className={`go-chip${source === s ? " go-chip-on" : ""}`}
                    onClick={() => setSource(s as "all" | WebhookSource)}
                  >
                    {s === "all" ? "すべて" : SOURCE_SHORT[s as WebhookSource]}
                  </button>
                ))}
              </div>
              <div className="go-fgroup">
                <span className="go-flabel">重要度</span>
                {(["all", "critical", "warning", "info", "unknown"] as const).map((s) => (
                  <button key={s} className={`go-chip${sev === s ? " go-chip-on" : ""}`} onClick={() => setSev(s)}>
                    {s === "all" ? "すべて" : s === "unknown" ? "なし" : SEVERITY_LABEL[s]}
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
              <div className="go-fgroup">
                <button
                  className={`go-chip${autoOnly ? " go-chip-on" : ""}`}
                  onClick={() => setAutoOnly((v) => !v)}
                  title="AI による自動事前調査が走った行だけを表示します"
                >
                  自動調査ありのみ
                </button>
              </div>
              <div className="go-fgroup go-fgroup-grow">
                <input
                  className="go-fsearch"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="本文 / 種別 / デバイス / サイトで絞り込み"
                />
              </div>
            </div>
          </section>

          {/* 一覧 */}
          <section className="go-panel go-table-panel">
            <header className="go-panel-head">
              <span className="go-panel-title">タイムライン</span>
              <span className="go-panel-note">
                受信の新しい順 · {shown.length} / {filtered.length} 件を表示
              </span>
            </header>
            <div className="go-table-scroll">
              <table className="go-table go-feed-table wf-table">
                <thead>
                  <tr>
                    <th className="wf-c-exp" aria-label="展開" />
                    <th className="go-fc-time">受信時刻</th>
                    <th className="go-fc-sev">重要度</th>
                    <th className="wf-c-src">ソース</th>
                    <th className="go-fc-site">サイト</th>
                    <th className="go-fc-cat">カテゴリ</th>
                    <th>内容</th>
                    <th className="go-fc-act" aria-label="操作" />
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
                        条件に一致する Webhook ログはありません
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

      {/* 取得方式・自動更新間隔。Global Overview のフッタと対になる位置に置くが、設定は別物。 */}
      <div className="go-foot go-mono">
        <span className="go-foot-interval">
          <b>Webhook ログの自動更新間隔</b>
          <select
            className="go-interval-select"
            value={intervalMs}
            disabled={savingInterval || !settings}
            onChange={(e) => void onChangeInterval(Number(e.target.value))}
            title="このタブ専用の設定です。サーバに保存され、コンテナ再作成後も保持されます。Global Overview の間隔設定とは別に管理されます。"
          >
            {(
              settings?.optionsMs ?? [
                60000, 180000, 300000, 600000, 900000, 1800000, 3_600_000, 86_400_000,
              ]
            ).map((ms) => (
              <option key={ms} value={ms}>
                {fmtInterval(ms)}
              </option>
            ))}
          </select>
          {savingInterval && <span className="go-interval-saving"> 保存中…</span>}
          <span
            className="go-foot-hint"
            title="この設定は Webhook ログ(Google スプレッドシート)の取得間隔だけを変えます。Global Overview の Central / Mist ポーリング間隔とは別に保存されます。"
          >
            (この設定は Webhook ログの取得のみ / Global Overview のポーリング間隔とは別設定です)
          </span>
        </span>
        {feed && (
          <>
            {" / "}手動更新の最短間隔 {Math.round(feed.minRefreshMs / 1000)} 秒 ・ 自動事前調査:{" "}
            {feed.auto.enabled
              ? `重大(Critical)のみ・最大 ${feed.auto.maxPerCycle} 件/巡・受信から ${Math.round(
                  feed.auto.maxAgeMs / 60000,
                )} 分以内・同一アラートは 1 回のみ(実行済み ${feed.auto.investigatedCount} 件)`
              : "無効"}
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
  const hasDetail = Boolean(item.auto || item.siteContext || Object.keys(item.raw).length > 0);
  const hasHistoryResult = Boolean(
    onOpenHistoryFocus && item.auto?.status === "done" && item.auto.runId,
  );
  return (
    <>
      <tr
        className={`${open ? "wf-row-open" : ""}${hasDetail ? " wf-row-click" : ""}`.trim()}
        onClick={hasDetail ? onToggle : undefined}
        title={hasDetail ? (open ? "クリックで閉じる" : "クリックで生データ・自動調査・サイト状況を表示する") : undefined}
      >
        <td className="wf-c-exp">
          <button
            className="wf-exp-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            title={open ? "閉じる" : "生データ・自動調査・サイト状況を表示する"}
            disabled={!hasDetail}
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
        <td className="go-fc-time go-mono">{fmtTime(item.receivedAt)}</td>
        <td className="go-fc-sev">
          <span
            className={`go-fsev wf-sev-${item.severity}`}
            title={item.severityRaw ? `シート上の値: ${item.severityRaw}` : "この通知は重要度を持ちません"}
          >
            {SEVERITY_LABEL[item.severity]}
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
                  ? "AI 自動調査中…"
                  : item.auto.status === "done"
                    ? "AI 自動事前調査あり"
                    : "AI 自動調査に失敗"}
              </span>
            )}
          </div>
        </td>
        <td className="go-fc-act wf-c-act">
          <div className="wf-act-col">
            {hasHistoryResult && (
              <button
                className="wf-history-btn"
                title="自動事前調査が実際に実行された過去の履歴(スレッド)を、ネットワーク調査タブで直接開きます"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenHistoryFocus!(item.auto!.runId!);
                }}
              >
                調査結果を見る
              </button>
            )}
            {onInvestigate && (
              <button
                className="go-investigate-btn"
                title={
                  item.auto?.status === "done"
                    ? "自動事前調査の結果を踏まえた追加質問のクエリ文を、ネットワーク調査タブへ渡します(実行はされません)"
                    : "この通知の要約をクエリ文にして、ネットワーク調査タブへ渡します(実行はされません)"
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
                調査する
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
                <div className="wf-dsec-title">生データ({item.sheet} の {item.rowIndex} 行目)</div>
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
  const a = item.auto!;
  return (
    <div className="wf-dsec wf-dsec-auto">
      <div className="wf-dsec-title">
        AI による自動事前調査
        <span className={`wf-auto-tag wf-auto-${a.status}`}>
          {a.status === "running" ? "実行中" : a.status === "done" ? "完了" : "失敗"}
        </span>
        <span className="go-mono wf-dim">
          {fmtTime(a.startedAt)}
          {a.finishedAt ? ` → ${fmtTime(a.finishedAt)}` : ""}
        </span>
      </div>
      <div className="wf-auto-query go-mono">クエリ: {a.query}</div>
      {a.status === "running" && (
        <div className="wf-auto-body wf-dim">
          Insight Agent が調査しています。完了すると自動でここに要約が出ます(この画面は 15 秒ごとに更新されます)。
        </div>
      )}
      {a.status === "error" && <div className="go-src-err">{a.error ?? "実行に失敗しました"}</div>}
      {a.status === "done" && <div className="wf-auto-body">{a.summary || "(回答が空でした)"}</div>}
      {a.runId && (
        <div className="wf-auto-foot go-mono wf-dim">
          ネットワーク調査タブのタイムラインに「自動調査」タグ付きで記録されています(runId: {a.runId})。
          右の「調査結果を見る」でその実行結果を直接開けます。さらに詳しく聞きたい場合は
          「調査する」から追加質問できます。
        </div>
      )}
    </div>
  );
}

function SitePanel({ item }: { item: WebhookFeedItem }) {
  const s = item.siteContext!;
  if (s.status === "unavailable") {
    return (
      <div className="wf-dsec">
        <div className="wf-dsec-title">関連情報(サイト状況)</div>
        <div className="wf-dim">{s.error ?? "サイトを特定できないため先読みしていません"}</div>
      </div>
    );
  }
  if (s.status === "error") {
    return (
      <div className="wf-dsec">
        <div className="wf-dsec-title">関連情報(サイト状況)</div>
        <div className="go-src-err">先読みに失敗しました: {s.error}</div>
      </div>
    );
  }
  return (
    <div className="wf-dsec wf-dsec-site">
      <div className="wf-dsec-title">
        関連情報(サイト状況)
        <span className="go-mono wf-dim">
          {s.siteName} · 取得 {fmtTime(s.fetchedAt)}
        </span>
      </div>
      <div className="wf-kpis">
        <div className="wf-kpi">
          <span className="wf-kpi-label">Health</span>
          <span className="wf-kpi-value">{s.healthScore === null ? "—" : s.healthScore}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">デバイス</span>
          <span className="wf-kpi-value">
            {s.devicesTotal === null ? "—" : `${s.devicesUp ?? 0} / ${s.devicesTotal}`}
          </span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">クライアント</span>
          <span className="wf-kpi-value">{s.clients ?? "—"}</span>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">未解決アラート</span>
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
      {s.alertsNote && <div className="wf-dim go-mono">アラートの母集団: {s.alertsNote}</div>}
    </div>
  );
}
