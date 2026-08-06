import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InvestigationRequest, PendingHistoryFocus, PluginEntry } from "../../../src/shell";
import type {
  HistoryRecord,
  KnowledgeRef,
  McpCall,
  McpHealth,
  NIEvent,
  Platform,
  PlatformJudgment,
  RoutingView,
  ScheduleConfig,
  SiteEntry,
  SiteStatusFile,
  SuggestedAction,
} from "./types";
import { MODEL_OPTIONS, DEFAULT_MODEL } from "./types";
import { useSetTopbarModel, topbarModelLabel } from "../../../src/shell";
import { formatDateTime, useLanguage } from "../../../src/i18n";
import {
  fetchHistory,
  fetchScheduleConfig,
  fetchScheduledQueries,
  fetchSiteMap,
  fetchSiteStatus,
  refreshSiteStatus,
  runQuery,
  subscribeEvents,
} from "./api";
import { HistoryThread } from "./HistoryThread";
import { SessionShareActions } from "./SessionShare";
import { SseLog } from "./SseLog";
import { SiteList } from "./SiteList";
import { Timeline } from "./Timeline";
import { Turn } from "./Turn";
import { sessionKey, sortTurnsAsc, turnFromRecord, turnFromRun, type SessionTurn } from "./session";
import "./styles.css";

// 実行中/完了した1クエリ分の見える化状態(SSE で積み上がる)。
interface RunState {
  query: string | null;
  site: string | null;
  ts: string | null; // run_start の時刻(共有レポートの「実行日時」に使う)
  model: string | null; // この実行に使ったモデル(共有レポート用)
  routing: RoutingView | null;
  calls: McpCall[];
  judgments: PlatformJudgment[];
  answer: { text: string; isError: boolean; reason: string | null } | null;
  platformsUsed: Platform[];
  suggestedActions: SuggestedAction[];
  /** MCP サーバーの接続健全性(09)。answer イベントと一緒に届く。 */
  mcpHealth: McpHealth | null;
  /** この実行の所要時間(ミリ秒)(26)。answer イベントと一緒に届く。 */
  durationMs: number | null;
  /** system prompt に注入された承認済みナレッジ(47)。注入が無かった実行では空のまま。 */
  knowledgeRefs: KnowledgeRef[];
}

function emptyRun(): RunState {
  return {
    query: null,
    site: null,
    ts: null,
    model: null,
    routing: null,
    calls: [],
    judgments: [],
    answer: null,
    platformsUsed: [],
    suggestedActions: [],
    mcpHealth: null,
    durationMs: null,
    knowledgeRefs: [],
  };
}

// Network Investigation プラグイン本体。クエリ入力 + 実行 + SSE ログ + サイト一覧を1画面に、
// その下にスケジュール実行タイムライン(Task 6)を積む。
// (地図表示は 03 Task 3 で削除。座標つきサイト表示は 05 の新規ダッシュボードへ移す。)
// CLAUDE.md 原則: View はキャッシュを持たず、サーバーが返す「今の値」を描画する。進捗・変更は
// SSE(/events)で通知を受け、今表示中のデータだけ refetch する。
//
// 04: 「続けて調べる」で繋がった一連を 1 セッションとして扱う。コンソール側も履歴側も
// 同じ Turn 部品でスレッド表示し、実行中の run が完了して履歴に載っても見た目が変わらない。
// コンソールに出す過去ターンは history(サーバーが返す今の値)から引く。ローカルに持つのは
// 「まだ履歴に載っていない実行中/直後の run」だけ。
export function NetworkInvestigation({
  plugin,
  focusId,
  pendingQuery,
  onConsumePendingQuery,
  pendingHistoryFocus,
  onConsumePendingHistoryFocus,
}: {
  plugin: PluginEntry;
  focusId?: string | null;
  /** Event/Alert タブ等の「調査する」から渡される事前入力クエリ(15番)。null なら何もしない */
  pendingQuery?: InvestigationRequest | null;
  onConsumePendingQuery?: () => void;
  /** Webhook ログの「調査結果を見る」から渡される runId(18番)。該当スレッドを直接開く */
  pendingHistoryFocus?: PendingHistoryFocus | null;
  onConsumePendingHistoryFocus?: () => void;
}) {
  // 言語は t() だけでなく日時整形(formatDateTime)にも渡すので lang も受け取る。
  const { lang, t } = useLanguage();
  const [entries, setEntries] = useState<SiteEntry[]>([]);
  const [siteStatus, setSiteStatus] = useState<SiteStatusFile>({ statuses: {}, updatedAt: null });
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig | null>(null);
  const [scheduledCount, setScheduledCount] = useState(0);
  // 開いているスレッド(タイムラインのカードクリック)。null ならコンソール画面。
  const [thread, setThread] = useState<{ sessionId: string; focusRecordId: string | null } | null>(null);
  const [threadReloadKey, setThreadReloadKey] = useState(0);

  const [queryText, setQueryText] = useState("");
  const [selectedSite, setSelectedSite] = useState<string>(""); // "" = サイト指定なし
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL); // 既定は Sonnet(常に明示的な値を送る)

  // コンソールで開いている調査セッション。実行ボタンは既定で新しいセッションを始め、
  // 「続けて調べる」チップ(と下の継続チェック)は現在のセッションに追加する。
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [sessionRunIds, setSessionRunIds] = useState<string[]>([]);
  const [continueSession, setContinueSession] = useState(false);
  const consoleThreadRef = useRef<HTMLDivElement>(null);

  // トップバーのモデル表示に、ドロップダウンで選択中のモデルをリアルタイムに反映する。
  // アンマウント時(他プラグインへ切替)は cleanup で消す。
  const setTopbarModel = useSetTopbarModel();
  useEffect(() => {
    setTopbarModel({ label: topbarModelLabel(selectedModel) });
    return () => setTopbarModel(null);
  }, [selectedModel, setTopbarModel]);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SSE をレースなく扱うため、runId ごとの状態を ref のバッファに溜め、表示は displayRunId で選ぶ。
  const runsRef = useRef<Map<string, RunState>>(new Map());
  // SSE ハンドラは購読時にキャプチャされるので、開いているスレッドの判定は ref 経由で見る。
  const threadSessionRef = useRef<string | null>(null);
  useEffect(() => {
    threadSessionRef.current = thread?.sessionId ?? null;
  }, [thread]);
  const [displayRunId, setDisplayRunId] = useState<string | null>(null);
  const displayRunIdRef = useRef<string | null>(null);
  const [tick, setTick] = useState(0); // ref バッファ更新時の再描画トリガ

  const reloadHistory = useCallback(() => {
    fetchHistory()
      .then(setHistory)
      .catch((e) => setError(String(e)));
  }, []);

  const reloadStatus = useCallback(() => {
    fetchSiteStatus()
      .then(setSiteStatus)
      .catch(() => {});
  }, []);

  // 定期実行のサマリ(タイムライン見出し用)。ScheduleEditor での編集後にも呼ぶ。
  const reloadSchedule = useCallback(() => {
    fetchScheduleConfig()
      .then(setScheduleConfig)
      .catch(() => {});
    fetchScheduledQueries()
      .then((qs) => setScheduledCount(qs.length))
      .catch(() => {});
  }, []);

  // 初期ロード。
  useEffect(() => {
    fetchSiteMap()
      .then(setEntries)
      .catch((e) => setError(String(e)));
    reloadSchedule();
    reloadStatus();
    reloadHistory();
  }, [reloadHistory, reloadStatus, reloadSchedule]);

  // Event/Alert タブ・サイト詳細ページの「調査する」で渡された事前入力クエリ(15番)。
  // 入力欄への反映は即時、サイト選択は entries(サイト一覧)が揃うまで待って突き合わせる。
  // 自動実行はしない(入力欄に入れてタブを開くところまで)。
  const [pendingSiteName, setPendingSiteName] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingQuery) return;
    setQueryText(pendingQuery.query);
    setPendingSiteName(pendingQuery.site);
    onConsumePendingQuery?.();
  }, [pendingQuery, onConsumePendingQuery]);
  useEffect(() => {
    if (!pendingSiteName) return;
    if (entries.some((e) => e.siteName === pendingSiteName)) {
      setSelectedSite(pendingSiteName);
      setPendingSiteName(null);
    }
  }, [entries, pendingSiteName]);

  // Webhook ログの「調査結果を見る」から渡された runId(18番)。該当セッションのスレッドを
  // 直接開き、そのターンまでスクロールする(HistoryThread 側の focusRecordId で実装済み)。
  // 自動事前調査の完了行からしか呼ばれないので history には既に載っているはずだが、
  // タブを開いた直後で history の初回取得が終わっていない場合は次の更新を待つ。
  useEffect(() => {
    if (!pendingHistoryFocus) return;
    const rec = history.find((r) => r.id === pendingHistoryFocus);
    if (!rec) return;
    setThread({ sessionId: sessionKey(rec), focusRecordId: rec.id });
    onConsumePendingHistoryFocus?.();
  }, [pendingHistoryFocus, history, onConsumePendingHistoryFocus]);

  // 上のエフェクトが待ち続けて何も起きない場合(19番)のタイムアウト救済。
  // 親(App)は onConsumePendingHistoryFocus を useCallback していないため毎レンダーで
  // 新しい関数になる。依存配列に入れるとタイマーが張り直され続けてしまうので、呼び出しは
  // ref 経由にし、タイマーの張り直しは pendingHistoryFocus の値が変わったときだけにする。
  const onConsumePendingHistoryFocusRef = useRef(onConsumePendingHistoryFocus);
  onConsumePendingHistoryFocusRef.current = onConsumePendingHistoryFocus;
  useEffect(() => {
    if (!pendingHistoryFocus) return;
    const timer = setTimeout(() => {
      setError(t("networkInvestigation.console.historyNotFound"));
      onConsumePendingHistoryFocusRef.current?.();
    }, 5000);
    return () => clearTimeout(timer);
    // t は言語切替時にだけ変わる。タイマーを張り直しても救済の意味は変わらないので依存に含める。
  }, [pendingHistoryFocus, t]);

  // SSE 購読。イベントは runId ごとにバッファへ反映し、表示中の run のときだけ再描画する。
  useEffect(() => {
    const ensure = (runId: string): RunState => {
      let s = runsRef.current.get(runId);
      if (!s) {
        s = emptyRun();
        runsRef.current.set(runId, s);
      }
      return s;
    };
    return subscribeEvents((ev: NIEvent) => {
      if (ev.type === "history") {
        reloadHistory();
        // 開いているスレッドに新しいターンが増えたら、そのスレッドも取り直す。
        if (ev.sessionId && threadSessionRef.current === ev.sessionId) setThreadReloadKey((k) => k + 1);
        return;
      }
      const s = ensure(ev.runId);
      switch (ev.type) {
        case "run_start":
          s.query = ev.query;
          s.site = ev.site;
          s.ts = ev.ts;
          break;
        case "routing_decision":
          s.routing = {
            used: ev.used,
            skipped: ev.skipped,
            reason: ev.reason,
            reasonCode: ev.reasonCode,
            reasonParams: ev.reasonParams,
            resolvedPlatform: ev.resolvedPlatform,
          };
          break;
        case "mcp_call": {
          const idx = s.calls.findIndex((c) => c.id === ev.id);
          const call: McpCall = {
            id: ev.id,
            server: ev.server,
            platform: ev.platform,
            tool: ev.tool,
            status: ev.status,
            detail: ev.detail,
            count: ev.count,
            // 出所(56)。ネイティブ AI 由来の呼び出しにだけバッジを出すための材料。
            aiSource: ev.aiSource,
            // 失敗詳細(08 Task 1)。実行中ログの行をクリックしたときに展開する材料。
            error: ev.error,
            errorStatus: ev.errorStatus,
            input: ev.input,
          };
          if (idx >= 0) s.calls[idx] = call;
          else s.calls.push(call);
          break;
        }
        case "knowledge_injected":
          // 承認済みナレッジの注入(47)。実行開始直後に 1 回だけ届く。
          s.knowledgeRefs = ev.refs ?? [];
          break;
        case "platform_judgment":
          if (!s.judgments.some((j) => j.platform === ev.platform)) {
            s.judgments.push({ platform: ev.platform, reason: ev.reason });
          }
          break;
        case "answer":
          s.answer = { text: ev.answer, isError: ev.isError, reason: ev.reason };
          s.platformsUsed = ev.platformsUsed ?? [];
          s.suggestedActions = ev.suggestedActions ?? [];
          // MCP 接続の警告(09)。ここを忘れると実行直後のターンにだけ警告が出ない。
          s.mcpHealth = ev.mcpHealth ?? null;
          // この実行の所要時間(26)。
          s.durationMs = ev.durationMs ?? null;
          break;
      }
      if (ev.runId === displayRunIdRef.current) setTick((t) => t + 1);
    });
  }, [reloadHistory]);

  const display: RunState = (displayRunId && runsRef.current.get(displayRunId)) || emptyRun();
  const running = Boolean(displayRunId) && display.answer == null;
  const isBusy = running;
  // tick を参照して「バッファ変更で再描画」を確実にする(display は ref 由来のため)。
  void tick;

  // クエリ実行の中核。入力欄・提案アクションの両方から同じ経路で呼ぶ。
  // continueOf に既存のセッションIDを渡すと「続けて調べる」= 同じスレッドのターンになる。
  // 省略するとサーバーが新しいセッションを採番する(= 新しい調査の開始)。
  const startRun = useCallback(
    async (q: string, site: string | null, model?: string, continueOf?: string | null) => {
      const query = q.trim();
      if (!query) return;
      setError(null);
      try {
        const { runId, sessionId: sid } = await runQuery(query, site, model, continueOf ?? undefined);
        // 既にこの runId の SSE(run_start / routing_decision)がバッファへ届いている可能性が
        // あるため、上書きせずマージする(先に届いたルーティング判定・呼び出し行を消さない)。
        const existing = runsRef.current.get(runId) ?? emptyRun();
        if (existing.query == null) existing.query = query;
        if (existing.site == null) existing.site = site;
        if (existing.ts == null) existing.ts = new Date().toISOString();
        existing.model = model ?? existing.model;
        runsRef.current.set(runId, existing);
        // 同じセッションの続きなら live run を積み増し、別セッションなら入れ替える。
        setSessionRunIds((prev) => (sid === sessionIdRef.current ? [...prev, runId] : [runId]));
        sessionIdRef.current = sid;
        setSessionId(sid);
        displayRunIdRef.current = runId;
        setDisplayRunId(runId);
        setTick((t) => t + 1);
      } catch (e) {
        setError(String(e));
      }
    },
    [],
  );

  const onRun = useCallback(() => {
    // 継続チェックが入っているときだけ現在のスレッドに追加する(既定は新しいセッション)。
    const continueOf = continueSession ? sessionId : null;
    void startRun(queryText, selectedSite || null, selectedModel, continueOf);
  }, [startRun, queryText, selectedSite, selectedModel, continueSession, sessionId]);

  // 提案アクション(「続けて調べる」)のクリック。クエリ・サイトを入力欄へ反映しつつ即時実行する。
  // 実行はそのセッションの次のターンとして記録される(04 Task 2)。
  // スレッド表示から呼ばれた場合は、そのスレッドを引き継いでコンソールへ戻す。
  const onRunAction = useCallback(
    (query: string, site: string | null, ofSession?: string | null) => {
      setQueryText(query);
      setSelectedSite(site ?? "");
      const continueOf = ofSession ?? sessionIdRef.current;
      if (ofSession) {
        // 履歴スレッドからの継続。コンソール側の live run を一旦リセットして開き直す。
        setThread(null);
        setSessionRunIds([]);
        sessionIdRef.current = ofSession;
        setSessionId(ofSession);
      }
      void startRun(query, site, selectedModel, continueOf);
    },
    [startRun, selectedModel],
  );

  // コンソールのチップから続ける(現在のセッションの次のターン)。
  const onConsoleRunAction = useCallback(
    (query: string, site: string | null) => onRunAction(query, site, null),
    [onRunAction],
  );

  const onRefreshStatus = useCallback(async () => {
    setStatusRefreshing(true);
    setError(null);
    try {
      const s = await refreshSiteStatus();
      setSiteStatus(s);
    } catch (e) {
      setError(String(e));
    } finally {
      setStatusRefreshing(false);
    }
  }, []);

  // 地図ピン選択・タイムラインカード選択 → クエリ欄に流し込む。
  const onSelectSite = useCallback(
    (siteName: string) => {
      setSelectedSite(siteName);
      setQueryText((prev) => prev || t("networkInvestigation.console.siteQuerySeed", { site: siteName }));
    },
    [t],
  );

  // スレッドの「このクエリを入力欄へ」。スレッドを閉じてクエリ欄へ流し込む。
  const onLoadQuery = useCallback((rec: HistoryRecord) => {
    setQueryText(rec.query);
    setSelectedSite(rec.site ?? "");
    setThread(null);
  }, []);

  // タイムラインのカードクリック → スレッド表示へ遷移(1 ターンだけの履歴もここで開く)。
  const onOpenHistory = useCallback((key: string, recordId: string) => {
    setThread({ sessionId: key, focusRecordId: recordId });
  }, []);

  // コンソールに出す「今のセッションのターン」。
  // 過去ターンは history(サーバーが返す今の値)から、まだ履歴に載っていない直近の実行だけを
  // ローカルの run バッファから補う(実行中の run は下の SseLog がライブ表示する)。
  const consoleTurns: SessionTurn[] = useMemo(() => {
    if (!sessionId) return [];
    const fromHistory = history.filter((r) => sessionKey(r) === sessionId).map(turnFromRecord);
    const known = new Set(fromHistory.map((t) => t.id));
    const live: SessionTurn[] = [];
    for (const runId of sessionRunIds) {
      if (known.has(runId)) continue;
      const rs = runsRef.current.get(runId);
      if (rs && rs.answer) live.push(turnFromRun(runId, rs));
    }
    return sortTurnsAsc([...fromHistory, ...live]);
  }, [history, sessionId, sessionRunIds, tick]);

  // 「新しい調査を始める」。コンソールのスレッドを畳むだけ(履歴は消えない)。
  const onNewSession = useCallback(() => {
    sessionIdRef.current = null;
    setSessionId(null);
    setSessionRunIds([]);
    setContinueSession(false);
    setDisplayRunId(null);
    displayRunIdRef.current = null;
  }, []);

  // サイトを platform ごとにグルーピングしてセレクトに出す。
  const grouped = useMemo(() => {
    const central = entries.filter((e) => e.platform === "central");
    const mist = entries.filter((e) => e.platform === "mist");
    return { central, mist };
  }, [entries]);

  // タイムラインのカードクリックで開くスレッド表示(04 Task 3)。開いている間はこれだけを表示する
  // (Discussion Panel の一覧 → スレッド詳細と同じ遷移)。
  if (thread) {
    return (
      <div className="ni-root">
        {error && (
          <div className="ni-error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <HistoryThread
          sessionId={thread.sessionId}
          focusRecordId={thread.focusRecordId}
          reloadKey={threadReloadKey}
          onBack={() => setThread(null)}
          onLoadQuery={onLoadQuery}
          onRunAction={onRunAction}
        />
      </div>
    );
  }

  return (
    <div className="ni-root">
      {error && (
        <div className="ni-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="ni-grid">
        {/* 左: クエリコンソール + SSE ログ + 回答 */}
        <div className="ni-console">
          <div className="ni-form">
            <textarea
              className="ni-input"
              placeholder={t("networkInvestigation.console.queryPlaceholder")}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onRun();
              }}
              rows={2}
            />
            <div className="ni-form-row">
              <select
                className="ni-select"
                value={selectedSite}
                onChange={(e) => setSelectedSite(e.target.value)}
                title={t("networkInvestigation.console.siteSelectTitle")}
              >
                <option value="">{t("networkInvestigation.console.siteAny")}</option>
                <optgroup label="Central">
                  {grouped.central.map((e) => (
                    <option key={e.siteId} value={e.siteName}>
                      {e.siteName}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Mist">
                  {grouped.mist.map((e) => (
                    <option key={e.siteId} value={e.siteName}>
                      {e.siteName}
                    </option>
                  ))}
                </optgroup>
              </select>
              <select
                className="ni-select ni-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                title={t("networkInvestigation.console.modelSelectTitle")}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {t("networkInvestigation.console.modelOption", { label: m.label })}
                  </option>
                ))}
              </select>
              <button className="ni-btn primary" onClick={onRun} disabled={isBusy || !queryText.trim()}>
                {t(`networkInvestigation.console.runBtn${isBusy ? "Busy" : ""}`)}
              </button>
            </div>
            <div className="ni-form-row ni-form-row-options">
              {/* 実行ボタンは既定で新しい調査(セッション)を始める。今のスレッドの続きにしたい
                  ときだけ明示的に選ばせる(「続けて調べる」チップは常に続きになる)。 */}
              {consoleTurns.length > 0 && (
                <label className="ni-continue" title={t("networkInvestigation.console.continueTitle")}>
                  <input
                    type="checkbox"
                    checked={continueSession}
                    onChange={(e) => setContinueSession(e.target.checked)}
                  />
                  <span className="ni-mono ni-dim">{t("networkInvestigation.console.continueLabel")}</span>
                </label>
              )}
            </div>
          </div>

          {/* 今の調査スレッド(04 Task 3)。「続けて調べる」でターンが積み上がっていく。 */}
          {consoleTurns.length > 0 && (
            <div className="ni-console-session">
              <div className="ni-console-session-head">
                <span className="ni-panel-title">
                  {t(
                    `networkInvestigation.console.threadHead${consoleTurns.length === 1 ? "One" : "Other"}`,
                    { n: consoleTurns.length },
                  )}
                </span>
                <div className="ni-console-session-actions">
                  {sessionId && consoleTurns.length > 1 && (
                    <SessionShareActions
                      sessionId={sessionId}
                      turns={consoleTurns}
                      screenRef={consoleThreadRef}
                    />
                  )}
                  <button
                    className="ni-btn sm"
                    onClick={onNewSession}
                    title={t("networkInvestigation.console.newSessionTitle")}
                  >
                    {t("networkInvestigation.console.newSessionBtn")}
                  </button>
                </div>
              </div>
              <div className="ni-thread" ref={consoleThreadRef}>
                {consoleTurns.map((t, i) => (
                  <Turn
                    key={t.id}
                    turn={t}
                    index={i}
                    total={consoleTurns.length}
                    onRunAction={onConsoleRunAction}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 実行中のライブ表示。完了したターンは上のスレッドに積まれる。 */}
          {(running || consoleTurns.length === 0) && (
            <SseLog
              routing={display.routing}
              knowledgeRefs={display.knowledgeRefs}
              calls={display.calls}
              judgments={display.judgments}
              running={running}
              query={display.query}
              site={display.site}
            />
          )}
        </div>

        {/* 右: サイト一覧(旧・地図の置き換え。Task 3) */}
        <div className="ni-sitepanel">
          <div className="ni-sitepanel-head">
            <span className="ni-panel-title">{t("networkInvestigation.sitePanel.title")}</span>
            <button
              className="ni-btn sm"
              onClick={onRefreshStatus}
              disabled={statusRefreshing}
              title={t("networkInvestigation.sitePanel.refreshTitle")}
            >
              {t(`networkInvestigation.sitePanel.refreshBtn${statusRefreshing ? "Busy" : ""}`)}
            </button>
          </div>
          <SiteList
            entries={entries}
            siteStatus={siteStatus}
            selectedSite={selectedSite}
            onSelectSite={onSelectSite}
          />
          <div className="ni-mono ni-dim ni-sitepanel-foot">
            {t("networkInvestigation.sitePanel.foot", {
              n: entries.length,
              central: grouped.central.length,
              mist: grouped.mist.length,
            })}
            {/* 33 L-10: 以前はロケール無しの toLocaleString() でブラウザ既定に依存していた。
                表示言語に合わせて ja-JP / en-US を選ぶ共通ヘルパへ寄せる。 */}
            {siteStatus.updatedAt
              ? t("networkInvestigation.sitePanel.statusFetched", {
                  when: formatDateTime(siteStatus.updatedAt, lang),
                })
              : t("networkInvestigation.sitePanel.statusNotFetched")}
          </div>
        </div>
      </div>

      {/* 下: スケジュール実行タイムライン + 定期実行の設定(Task 5) */}
      <Timeline
        history={history}
        scheduleConfig={scheduleConfig}
        scheduledCount={scheduledCount}
        entries={entries}
        focusId={focusId ?? null}
        onOpen={onOpenHistory}
        onScheduleChanged={reloadSchedule}
      />
    </div>
  );
}
