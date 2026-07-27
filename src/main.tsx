// multi-network-dashboard — フロントエンドのエントリ。
//
// Corstack 本体のシェル(プラグイン一覧・ルーター・共通検索・Home)は持ち込まない。
// 画面は 2 枚だけなので、ルーティングライブラリは入れずローカル state のタブ切替で足りる(06 Task 1)。
//   - global-overview        … Central / Mist 直接 API のダッシュボード
//   - network-investigation  … 既存の調査ページ
//
// タブの実装方針:
//   ・両方を「一度開いたらマウントしたまま」にし、非表示側は CSS(display:none)で隠す。
//     network-investigation は SSE 接続・入力途中のクエリ・開いているスレッドを抱えているので、
//     タブを戻すたびに作り直すと作業が消える。地図(Leaflet)も再生成すると視点が飛ぶ。
//   ・そのぶん非表示側でポーリングが回り続けないよう、GlobalOverview には active を渡す。
//   ・選択タブは localStorage に覚えて、リロードで戻らないようにする。
//
// URL の ?focus=<historyId>(Corstack の共通検索から飛んでくる形)は、共通検索が無い本アプリでも
// 「タイムラインの特定カードを開いた状態で共有する」用途に使えるので、そのまま解釈する。

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NetworkInvestigation } from "../plugins/network-investigation/view/NetworkInvestigation";
import { GlobalOverview } from "../plugins/global-overview/view/GlobalOverview";
import { EventFeed } from "../plugins/global-overview/view/EventFeed";
import { WebhookFeed } from "../plugins/webhook-feed/view/WebhookFeed";
import { CentralStreaming } from "../plugins/central-streaming/view/CentralStreaming";
import {
  TopbarModelContext,
  type InvestigationRequest,
  type PendingHistoryFocus,
  type PluginEntry,
  type TopbarModel,
} from "./shell";
import { applyTheme, resolveInitialTheme, storeTheme, type Theme } from "./theme";
import "./theme.css";

// Corstack の registry.json 相当。単一アプリなので固定値。
const PLUGIN: PluginEntry = {
  id: "network-investigation",
  name: "ネットワーク調査",
  sub: "Central / Mist 横断",
  order: 2,
};

type TabId =
  | "global-overview"
  | "event-feed"
  | "webhook-feed"
  | "central-streaming"
  | "network-investigation";

const TABS: Array<{ id: TabId; label: string; sub: string }> = [
  { id: "global-overview", label: "Global Overview", sub: "Central / Mist 直接 API" },
  { id: "event-feed", label: "Event / Alert", sub: "全サイト横断・オンデマンド取得" },
  { id: "webhook-feed", label: "Webhook ログ", sub: "New Central / Classic Central / Mist(スプレッドシート経由)" },
  { id: "central-streaming", label: "Streaming(Central)", sub: "New Central Streaming API(WSS 常時接続)" },
  { id: "network-investigation", label: "ネットワーク調査", sub: "Central / Mist 横断" },
];

const TAB_STORAGE_KEY = "mnd-tab";

function isTabId(v: unknown): v is TabId {
  return TABS.some((t) => t.id === v);
}

// ?focus= 付きで開かれたときは調査ページの特定カードを見に来ているので、そちらを初期表示にする。
function initialTab(focusId: string | null): TabId {
  if (focusId) return "network-investigation";
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    if (isTabId(v)) return v;
  } catch {
    /* localStorage が使えない環境では既定タブ */
  }
  return "global-overview";
}

// ダーク/ライト切替トグル(03 Task 1)。
// 属性の初期値は index.html のインラインスクリプトが既に入れているので、ここでは
// 「今の選択を state に持ち、クリックで反転して localStorage へ保存する」だけを行う。
// 06: 地図タイルの明暗もテーマに追従させるため、値そのものは App 側で持つ。
function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const nextLabel = theme === "dark" ? "ライト" : "ダーク";
  return (
    <button
      className="app-theme-btn app-theme-toggle"
      onClick={() => onChange(theme === "dark" ? "light" : "dark")}
      title={`${nextLabel}モードに切り替える(選択はこのブラウザに保存されます)`}
      aria-label={`${nextLabel}モードに切り替える`}
    >
      <span className="app-theme-icon" aria-hidden>
        {theme === "dark" ? "☀" : "☾"}
      </span>
      {nextLabel}
    </button>
  );
}

function App() {
  const focusId = new URLSearchParams(window.location.search).get("focus");
  // View が報告してくる「今使うモデル」。Corstack ではシェルのトップバーに出していたもの。
  const [model, setModel] = useState<TopbarModel | null>(null);
  const [theme, setTheme] = useState<Theme>(() => resolveInitialTheme());
  const [tab, setTab] = useState<TabId>(() => initialTab(focusId));
  // 一度でも開いたタブは、以降マウントしたままにする(初回は開いた側だけを作る)。
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([initialTab(focusId)]));
  // Event/Alert・Webhook ログ →「調査する」で渡す事前入力クエリ(15番。17 番で Webhook ログも利用)。ネットワーク調査タブが
  // マウント時/更新時に読み、反映したらクリアする。それまでは他タブの操作に影響しない。
  const [pendingInvestigationQuery, setPendingInvestigationQuery] = useState<InvestigationRequest | null>(null);
  // Webhook ログ →「調査結果を見る」で渡す、過去実行の直接ジャンプ先(18番)。
  // pendingInvestigationQuery とは独立に管理し、互いのタブ切替・消費に影響しないようにする。
  const [pendingHistoryFocus, setPendingHistoryFocus] = useState<PendingHistoryFocus | null>(null);

  // StrictMode の二重実行でも冪等(同じ属性を入れ直すだけ)。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const onTheme = useCallback((t: Theme) => {
    setTheme(t);
    storeTheme(t);
  }, []);

  const onTab = useCallback((id: TabId) => {
    setTab(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, id);
    } catch {
      /* 保存できない環境ではセッション内のみ */
    }
  }, []);

  // Event/Alert タブ・サイト詳細ページの「調査する」ボタンから呼ばれる。
  // クエリを共有stateに積んで、ネットワーク調査タブへ切り替えるところまでを行う
  // (実行はしない。文面を用意してタブを切り替えるだけ)。
  const onInvestigate = useCallback(
    (req: InvestigationRequest) => {
      setPendingInvestigationQuery(req);
      onTab("network-investigation");
    },
    [onTab],
  );

  // Webhook ログの「調査結果を見る」ボタンから呼ばれる。runId を共有stateに積んで
  // ネットワーク調査タブへ切り替えるところまでを行う(新しいクエリは組み立てない)。
  const onOpenHistoryFocus = useCallback(
    (runId: PendingHistoryFocus) => {
      setPendingHistoryFocus(runId);
      onTab("network-investigation");
    },
    [onTab],
  );

  return (
    <TopbarModelContext.Provider value={setModel}>
      <div className="app-shell">
        <div className="app-bar">
          <span className="app-title">Multi Network Dashboard</span>
          <nav className="app-tabs" role="tablist" aria-label="画面切替">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`app-tab${tab === t.id ? " app-tab-on" : ""}`}
                onClick={() => onTab(t.id)}
                title={t.sub}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {model && tab === "network-investigation" && <span className="app-model">model: {model.label}</span>}
          <ThemeToggle theme={theme} onChange={onTheme} />
        </div>
        <div className="app-body">
          {visited.has("global-overview") && (
            <div className="app-pane" hidden={tab !== "global-overview"}>
              <GlobalOverview active={tab === "global-overview"} theme={theme} onInvestigate={onInvestigate} />
            </div>
          )}
          {visited.has("event-feed") && (
            <div className="app-pane" hidden={tab !== "event-feed"}>
              <EventFeed active={tab === "event-feed"} onInvestigate={onInvestigate} />
            </div>
          )}
          {visited.has("webhook-feed") && (
            <div className="app-pane" hidden={tab !== "webhook-feed"}>
              <WebhookFeed
                active={tab === "webhook-feed"}
                onInvestigate={onInvestigate}
                onOpenHistoryFocus={onOpenHistoryFocus}
              />
            </div>
          )}
          {visited.has("central-streaming") && (
            <div className="app-pane" hidden={tab !== "central-streaming"}>
              <CentralStreaming active={tab === "central-streaming"} onInvestigate={onInvestigate} />
            </div>
          )}
          {visited.has("network-investigation") && (
            <div className="app-pane" hidden={tab !== "network-investigation"}>
              <NetworkInvestigation
                plugin={PLUGIN}
                focusId={focusId}
                pendingQuery={pendingInvestigationQuery}
                onConsumePendingQuery={() => setPendingInvestigationQuery(null)}
                pendingHistoryFocus={pendingHistoryFocus}
                onConsumePendingHistoryFocus={() => setPendingHistoryFocus(null)}
              />
            </div>
          )}
        </div>
      </div>
    </TopbarModelContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
