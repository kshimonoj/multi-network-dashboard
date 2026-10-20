// 左縦ナビ(Navigation Rail)(89)。上部のタブバー(06 / 76)を置き換えたもの。
//
//   ・収納時はアイコンのみ(--nav-width-collapsed)。展開時はラベルとグループ見出しを出す(--nav-width-expanded)。
//   ・展開は 2 通り。
//       ホバー一時展開 … ナビだけが幅を広げてコンテンツの上に重なる(コンテンツの幅は変えない)。
//                        誤爆を避けるため、開くのは 200ms、閉じるのは 300ms 留まってから。
//       ピン留め       … 置き場(.app-nav-slot)ごと広がり、コンテンツを押し出す。localStorage に保持。
//                        ボタンは項目一覧より前(Tab 順: ヘッダー → ピン留め → 10 項目 → コンテンツ)。
//   ・選択状態は持たない。どれが選ばれているかは呼び出し側(App の tab state)が渡す。
//     グループ分けは表示の都合だけなので、ここにだけ持つ(タブの定義・順序は main.tsx の TABS)。
//   ・印刷では #root ごと消える(network-investigation/view/styles.css の @media print)。
//     ポータルで #root の外に出すと紙面に載るので、出さないこと。

import { useCallback, useEffect, useRef, useState, type FocusEvent } from "react";
import { useT } from "../i18n";
import { Icon, type IconName } from "./Icon";

export type NavItem<Id extends string> = {
  id: Id;
  /** 辞書のキー接頭辞(`${key}.label` / `${key}.sub`)。main.tsx の TABS と同じ値。 */
  key: string;
  icon: IconName;
  /** Coach だけ amber にする(--accent-amber。シェルからは --coach が解決できないため)。 */
  tone?: "coach";
  /** 件数バッジの説明文の辞書キー({n} を埋める)。バッジを出す項目だけに付ける。 */
  badgeTitleKey?: string;
};

export type NavGroup<Id extends string> = {
  /** 辞書キー(nav.groups.<x>) */
  key: string;
  items: Array<NavItem<Id>>;
};

const PIN_STORAGE_KEY = "mnd-nav-pinned";
const HOVER_OPEN_DELAY_MS = 200;
const HOVER_CLOSE_DELAY_MS = 300;

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function NavRail<Id extends string>({
  groups,
  selected,
  onSelect,
  badges,
}: {
  groups: Array<NavGroup<Id>>;
  selected: Id;
  onSelect: (id: Id) => void;
  /** 項目ごとの件数バッジ(0 / 未指定なら出さない)。 */
  badges?: Partial<Record<Id, number>>;
}) {
  const t = useT();
  const [pinned, setPinned] = useState<boolean>(readPinned);
  // ホバー(またはキーボードでのフォーカス)による一時展開。ピン留め中は見た目に影響しない。
  const [peek, setPeek] = useState(false);
  const timer = useRef<number | null>(null);
  const hovered = useRef(false);
  const navRef = useRef<HTMLElement>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const schedulePeek = useCallback(
    (open: boolean, ms: number) => {
      clearTimer();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setPeek(open);
      }, ms);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(PIN_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* 保存できない環境ではセッション内のみ */
      }
      return next;
    });
  }, []);

  // キーボードで入ってきたときは、ラベルが読めるよう遅延なしで開く。
  // マウスのクリックでもフォーカスは来るので、:focus-visible のときだけに限る。
  const onFocus = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) {
        clearTimer();
        setPeek(true);
      }
    },
    [clearTimer],
  );

  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget;
      if (next instanceof Node && navRef.current?.contains(next)) return;
      if (!hovered.current) {
        clearTimer();
        setPeek(false);
      }
    },
    [clearTimer],
  );

  const expanded = pinned || peek;
  const overlay = peek && !pinned;
  const pinLabel = pinned ? t("nav.unpin") : t("nav.pin");

  return (
    <div className={`app-nav-slot${pinned ? " app-nav-slot-pinned" : ""}`}>
      <nav
        ref={navRef}
        className={`app-nav${expanded ? " app-nav-expanded" : ""}${overlay ? " app-nav-overlay" : ""}`}
        aria-label={t("app.tabsAriaLabel")}
        onMouseEnter={() => {
          hovered.current = true;
          if (!peek) schedulePeek(true, HOVER_OPEN_DELAY_MS);
          else clearTimer();
        }}
        onMouseLeave={() => {
          hovered.current = false;
          if (navRef.current?.contains(document.activeElement) && document.activeElement?.matches(":focus-visible")) {
            clearTimer();
            return;
          }
          schedulePeek(false, HOVER_CLOSE_DELAY_MS);
        }}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <button
          type="button"
          className={`app-nav-item app-nav-pin${pinned ? " app-nav-pin-on" : ""}`}
          aria-pressed={pinned}
          aria-label={pinLabel}
          title={t("nav.pinTitle", { action: pinLabel })}
          onClick={togglePin}
        >
          <span className="app-nav-icon-wrap">
            <Icon name={pinned ? "keepOff" : "keep"} className="app-nav-icon" />
          </span>
          <span className="app-nav-label">{pinLabel}</span>
        </button>
        <div className="app-nav-list">
          {groups.map((g) => (
            <div key={g.key} className="app-nav-group" role="group" aria-label={t(`nav.groups.${g.key}`)}>
              <div className="app-nav-group-head" aria-hidden="true">
                <span className="app-nav-group-rule" />
                <span className="app-nav-group-text">{t(`nav.groups.${g.key}`)}</span>
              </div>
              {g.items.map((it) => {
                const on = it.id === selected;
                const label = t(`${it.key}.label`);
                const n = it.badgeTitleKey ? (badges?.[it.id] ?? 0) : 0;
                const badgeText = n > 0 && it.badgeTitleKey ? t(it.badgeTitleKey, { n }) : "";
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={`app-nav-item${on ? " app-nav-item-on" : ""}${it.tone === "coach" ? " app-nav-item-coach" : ""}`}
                    aria-current={on ? "page" : undefined}
                    aria-label={n > 0 ? t("nav.itemWithBadge", { label, badge: badgeText }) : label}
                    title={t(`${it.key}.sub`)}
                    onClick={() => onSelect(it.id)}
                  >
                    <span className="app-nav-icon-wrap">
                      <Icon name={it.icon} className="app-nav-icon" />
                      {n > 0 && <span className="app-nav-dot" title={badgeText} />}
                    </span>
                    <span className="app-nav-label">{label}</span>
                    {n > 0 && (
                      <span className="app-nav-badge" title={badgeText}>
                        {n}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
