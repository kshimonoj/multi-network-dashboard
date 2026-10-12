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

import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NetworkInvestigation } from "../plugins/network-investigation/view/NetworkInvestigation";
import { GlobalOverview } from "../plugins/global-overview/view/GlobalOverview";
import { EventFeed } from "../plugins/global-overview/view/EventFeed";
import { WebhookFeed } from "../plugins/webhook-feed/view/WebhookFeed";
import { CentralStreaming } from "../plugins/central-streaming/view/CentralStreaming";
import { Reports } from "../plugins/reports/view/Reports";
import { Knowledge } from "../plugins/knowledge/view/Knowledge";
import { BestPractice } from "../plugins/best-practice/view/BestPractice";
import { TaggedTargets } from "../plugins/tagged-targets/view/TaggedTargets";
import { Coach } from "../plugins/coach/view/Coach";
import { fetchPendingCount } from "../plugins/knowledge/view/api";
import {
  TopbarModelContext,
  type InvestigationRequest,
  type PendingHistoryFocus,
  type PendingKnowledgeFocus,
  type PendingRuleFocus,
  type PluginEntry,
  type SiteFocusRequest,
  type TopbarModel,
} from "./shell";
import { useStaleBuild } from "./buildCheck";
import { applyTheme, resolveInitialTheme, storeTheme, type Theme } from "./theme";
import { LanguageProvider, useLanguage, useT, type Lang, type TFunc } from "./i18n";
import { Icon } from "./components/Icon";
import { NavRail, type NavGroup } from "./components/NavRail";
import "./theme.css";
import "./nav.css";

type TabId =
  | "global-overview"
  | "event-feed"
  | "webhook-feed"
  | "central-streaming"
  | "reports"
  | "knowledge"
  | "network-investigation"
  | "best-practice"
  | "tagged-targets"
  | "coach";

// タブの並びと、辞書のキー接頭辞だけをここに持つ(表示文言は src/i18n/*.json)。
const TABS: Array<{ id: TabId; key: string }> = [
  { id: "global-overview", key: "tabs.globalOverview" },
  { id: "event-feed", key: "tabs.eventFeed" },
  { id: "webhook-feed", key: "tabs.webhookFeed" },
  { id: "central-streaming", key: "tabs.centralStreaming" },
  { id: "reports", key: "tabs.reports" },
  { id: "knowledge", key: "tabs.knowledge" },
  { id: "network-investigation", key: "tabs.networkInvestigation" },
  { id: "best-practice", key: "tabs.bestPractice" },
  { id: "tagged-targets", key: "tabs.taggedTargets" },
  { id: "coach", key: "tabs.coach" },
];

// 左縦ナビ(89)での見せ方。グループ分けとアイコンは表示の都合だけなので、TABS とは別に持つ
// (並びは TABS と同じ。TABS に足したタブはここにも足すこと。足し忘れるとナビに出ない)。
const NAV_GROUPS: Array<NavGroup<TabId>> = [
  {
    key: "monitor",
    items: [
      { id: "global-overview", key: "tabs.globalOverview", icon: "language" },
      { id: "event-feed", key: "tabs.eventFeed", icon: "notifications" },
      { id: "webhook-feed", key: "tabs.webhookFeed", icon: "webhook" },
      { id: "central-streaming", key: "tabs.centralStreaming", icon: "stream" },
    ],
  },
  {
    key: "archive",
    items: [
      { id: "reports", key: "tabs.reports", icon: "description" },
      { id: "knowledge", key: "tabs.knowledge", icon: "lightbulb", badgeTitleKey: "knowledge.badgeTitle" },
    ],
  },
  {
    key: "analyze",
    items: [
      { id: "network-investigation", key: "tabs.networkInvestigation", icon: "search" },
      { id: "best-practice", key: "tabs.bestPractice", icon: "checklist" },
      { id: "tagged-targets", key: "tabs.taggedTargets", icon: "label" },
    ],
  },
  {
    key: "learn",
    items: [{ id: "coach", key: "tabs.coach", icon: "school", tone: "coach" }],
  },
];

// TABS にあって NAV_GROUPS に無いタブは、選択できるのにナビに出ない。開発時だけ気付けるようにする。
if (import.meta.env.DEV) {
  const navIds = new Set(NAV_GROUPS.flatMap((g) => g.items.map((it) => it.id)));
  const missing = TABS.filter((tb) => !navIds.has(tb.id)).map((tb) => tb.id);
  if (missing.length > 0) console.error(`[nav] NAV_GROUPS に無いタブ: ${missing.join(", ")}`);
}

/** 未承認のナレッジ候補を見失わないための、タブ名横のバッジ更新間隔(46 Task 4-5)。 */
const KNOWLEDGE_BADGE_MS = 60_000;

// Corstack の registry.json 相当。単一アプリなので固定値。
// name / sub だけは言語で変わるので、描画時に辞書から引く。
function usePlugin(t: TFunc): PluginEntry {
  return {
    id: "network-investigation",
    name: t("plugin.networkInvestigation.name"),
    sub: t("plugin.networkInvestigation.sub"),
    order: 2,
  };
}

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

// 左上のロゴ表記(76番)。「Multi Network Dashboard」は文字数が多くヘッダーを圧迫するため、
// public/favicon.svg と同じネットワーク図モチーフ + "MND" の短縮表記に置き換える。
// 何のアプリかはツールチップ(title)とaria-labelで正式名称を添えて分かるようにする。
function Logo({ title }: { title: string }) {
  return (
    <span className="app-logo" title={title} aria-label={title}>
      <svg className="app-logo-icon" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
        <rect x="0" y="0" width="32" height="32" rx="7" fill="var(--badge-bg)" />
        <g stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M16 16 L8 9 M16 16 L24 9 M16 16 L8 23 M16 16 L24 23" />
        </g>
        <g fill="var(--accent)">
          <circle cx="16" cy="16" r="4.4" />
          <circle cx="8" cy="9" r="3" />
          <circle cx="24" cy="9" r="3" />
          <circle cx="8" cy="23" r="3" />
          <circle cx="24" cy="23" r="3" />
        </g>
      </svg>
      <span className="app-logo-text">MND</span>
    </span>
  );
}

// ダーク/ライト切替トグル(03 Task 1)。
// 属性の初期値は index.html のインラインスクリプトが既に入れているので、ここでは
// 「今の選択を state に持ち、クリックで反転して localStorage へ保存する」だけを行う。
// 06: 地図タイルの明暗もテーマに追従させるため、値そのものは App 側で持つ。
function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const t = useT();
  const nextLabel = theme === "dark" ? t("theme.light") : t("theme.dark");
  return (
    <button
      className="app-theme-btn app-theme-toggle"
      onClick={() => onChange(theme === "dark" ? "light" : "dark")}
      title={t("theme.toggleTitle", { next: nextLabel })}
      aria-label={t("theme.toggleAria", { next: nextLabel })}
    >
      <Icon name={theme === "dark" ? "lightMode" : "darkMode"} className="app-theme-icon" />
      {nextLabel}
    </button>
  );
}

// 表示言語の切替(29 Task 2)。テーマトグルと同じ並び・同じ見た目の枠に収める。
// テーマは 2 値なのでトグルボタンだが、言語は「今どちらなのか」が一目で分かる方が良いので
// プルダウン(select)にし、選択中の言語名をそのまま表示する。
function LanguageSelect() {
  const { lang, setLang, t } = useLanguage();
  return (
    <label className="app-theme-btn app-lang" title={t("language.switchTitle")}>
      <Icon name="translate" className="app-theme-icon" />
      <select
        className="app-lang-select"
        value={lang}
        aria-label={t("language.switchAria")}
        onChange={(e) => setLang(e.target.value as Lang)}
      >
        <option value="ja">{t("language.ja")}</option>
        <option value="en">{t("language.en")}</option>
      </select>
    </label>
  );
}

function App() {
  const t = useT();
  const plugin = usePlugin(t);
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
  // Webhook ログ / レポート →「調査結果を見る」で渡す、過去実行の直接ジャンプ先(18番。44番でレポートも利用)。
  // pendingInvestigationQuery とは独立に管理し、互いのタブ切替・消費に影響しないようにする。
  const [pendingHistoryFocus, setPendingHistoryFocus] = useState<PendingHistoryFocus | null>(null);
  // レポートタブ →「サイト詳細ページで確認できます」のリンクで渡すサイト(43番)。
  // Global Overview がスナップショットと突き合わせて詳細ページを開き、反映したらクリアする。
  const [pendingSiteFocus, setPendingSiteFocus] = useState<SiteFocusRequest | null>(null);
  // ナレッジタブの未承認候補数(46 Task 4-5)。タブを開いていなくても増えるので、
  // シェル側で定期的に取りに行く(応答は数 KB)。ナレッジタブを開いている間は
  // そちらの操作結果(onPendingCount)が即座に上書きする。
  const [knowledgePending, setKnowledgePending] = useState(0);
  // Coach タブの根拠リンク →「このナレッジを見る」/「このルールを見る」で渡す飛び先(65番)。
  // 既存の pendingHistoryFocus と同じ形で、対象タブが消費したらクリアする。
  const [pendingKnowledgeFocus, setPendingKnowledgeFocus] = useState<PendingKnowledgeFocus | null>(null);
  const [pendingRuleFocus, setPendingRuleFocus] = useState<PendingRuleFocus | null>(null);
  // サーバが配っているビルドと食い違っていないか(82)。開きっぱなしのタブが古い JS のまま
  // 動いていると、サーバ側の修正だけが効いた紛らわしい状態になるので、再読み込みを促す。
  const staleBuild = useStaleBuild();

  // StrictMode の二重実行でも冪等(同じ属性を入れ直すだけ)。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // バッジ用の件数だけを定期取得する(ナレッジタブ自体はマウントしていなくてよい)。
  useEffect(() => {
    let alive = true;
    const tick = () => {
      void fetchPendingCount()
        .then((n) => {
          if (alive) setKnowledgePending(n);
        })
        .catch(() => {
          /* 取得できない間はバッジを更新しないだけ(画面は壊さない) */
        });
    };
    tick();
    const timer = setInterval(tick, KNOWLEDGE_BADGE_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

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

  // Webhook ログ / レポートの「調査結果を見る」ボタンから呼ばれる。runId を共有stateに積んで
  // ネットワーク調査タブへ切り替えるところまでを行う(新しいクエリは組み立てない)。
  const onOpenHistoryFocus = useCallback(
    (runId: PendingHistoryFocus) => {
      setPendingHistoryFocus(runId);
      onTab("network-investigation");
    },
    [onTab],
  );

  // レポートタブのサイトリンクから呼ばれる(43番)。サイトを共有stateに積んで
  // Global Overview タブへ切り替える(詳細ページを開くのは GlobalOverview 側)。
  const onOpenSite = useCallback(
    (req: SiteFocusRequest) => {
      setPendingSiteFocus(req);
      onTab("global-overview");
    },
    [onTab],
  );

  // Coach の根拠リンクから呼ばれる(65番)。ナレッジタブ / ベストプラクティスタブの
  // 該当エントリ・該当ルールを共有stateに積んで、そのタブへ切り替えるところまでを行う。
  const onOpenKnowledgeEntry = useCallback(
    (id: PendingKnowledgeFocus) => {
      setPendingKnowledgeFocus(id);
      onTab("knowledge");
    },
    [onTab],
  );

  const onOpenRule = useCallback(
    (ruleId: PendingRuleFocus) => {
      setPendingRuleFocus(ruleId);
      onTab("best-practice");
    },
    [onTab],
  );

  return (
    <TopbarModelContext.Provider value={setModel}>
      <div className="app-shell">
        <header className="app-bar">
          <Logo title={t("app.title")} />
          <div className="app-bar-actions">
            {model && tab === "network-investigation" && (
              <span className="app-model">
                {t("app.modelPrefix")} {model.label}
              </span>
            )}
            <LanguageSelect />
            <ThemeToggle theme={theme} onChange={onTheme} />
          </div>
        </header>
        {staleBuild && (
          <div className="app-stale" role="status">
            <span className="app-stale-text">{t("app.staleBuild.message")}</span>
            <button className="app-stale-btn" onClick={() => window.location.reload()}>
              {t("app.staleBuild.reload")}
            </button>
          </div>
        )}
        <div className="app-main">
          <NavRail
            groups={NAV_GROUPS}
            selected={tab}
            onSelect={onTab}
            badges={{ knowledge: knowledgePending }}
          />
          <div className="app-body">
            {visited.has("global-overview") && (
              <div className="app-pane" hidden={tab !== "global-overview"}>
                <GlobalOverview
                  active={tab === "global-overview"}
                  theme={theme}
                  onInvestigate={onInvestigate}
                  pendingSiteFocus={pendingSiteFocus}
                  onConsumePendingSiteFocus={() => setPendingSiteFocus(null)}
                />
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
            {visited.has("reports") && (
              <div className="app-pane" hidden={tab !== "reports"}>
                <Reports
                  active={tab === "reports"}
                  onInvestigate={onInvestigate}
                  onOpenSite={onOpenSite}
                  onOpenHistoryFocus={onOpenHistoryFocus}
                />
              </div>
            )}
            {visited.has("knowledge") && (
              <div className="app-pane" hidden={tab !== "knowledge"}>
                <Knowledge
                  active={tab === "knowledge"}
                  onOpenHistoryFocus={onOpenHistoryFocus}
                  onPendingCount={setKnowledgePending}
                  pendingEntryFocus={pendingKnowledgeFocus}
                  onConsumePendingEntryFocus={() => setPendingKnowledgeFocus(null)}
                />
              </div>
            )}
            {visited.has("network-investigation") && (
              <div className="app-pane" hidden={tab !== "network-investigation"}>
                <NetworkInvestigation
                  plugin={plugin}
                  focusId={focusId}
                  pendingQuery={pendingInvestigationQuery}
                  onConsumePendingQuery={() => setPendingInvestigationQuery(null)}
                  pendingHistoryFocus={pendingHistoryFocus}
                  onConsumePendingHistoryFocus={() => setPendingHistoryFocus(null)}
                />
              </div>
            )}
            {visited.has("best-practice") && (
              <div className="app-pane" hidden={tab !== "best-practice"}>
                <BestPractice
                  active={tab === "best-practice"}
                  pendingRuleFocus={pendingRuleFocus}
                  onConsumePendingRuleFocus={() => setPendingRuleFocus(null)}
                />
              </div>
            )}
            {visited.has("tagged-targets") && (
              <div className="app-pane" hidden={tab !== "tagged-targets"}>
                <TaggedTargets active={tab === "tagged-targets"} />
              </div>
            )}
            {/* Coach(65)。壁打ちは入力途中の文とセッション状態を抱えるので、
                既存の visited + hidden パターンに乗せてマウントを維持する。 */}
            {visited.has("coach") && (
              <div className="app-pane" hidden={tab !== "coach"}>
                <Coach
                  active={tab === "coach"}
                  onOpenKnowledgeEntry={onOpenKnowledgeEntry}
                  onOpenHistoryFocus={onOpenHistoryFocus}
                  onOpenRule={onOpenRule}
                  onInvestigate={onInvestigate}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </TopbarModelContext.Provider>
  );
}

// 開発時だけの注釈ツールバー(85)。vite build では import.meta.env.DEV が false に置き換わり、
// 動的 import ごと消える(静的 import にしないこと。src/devtools/AgentationDev.tsx 冒頭参照)。
const AgentationDev = import.meta.env.DEV ? lazy(() => import("./devtools/AgentationDev")) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
    {AgentationDev && (
      <Suspense fallback={null}>
        <AgentationDev />
      </Suspense>
    )}
  </StrictMode>,
);
