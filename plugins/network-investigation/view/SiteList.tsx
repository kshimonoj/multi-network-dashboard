import { useMemo } from "react";
import { LogoBadge } from "./LogoBadge";
import type { SiteEntry, SiteStatusFile } from "./types";

// サイト一覧(03 Task 3)。
//
// 旧・地図(Leaflet ピン)の置き換え。地図は 05 の新規 API ダッシュボードへ移すため、この
// 調査ページからは削除した。ピンが担っていた機能 —「サイトを選ぶ」「簡易ステータス(health /
// devices / clients / alerts)を見る」— は、座標に依存しないリスト表示で引き継ぐ。
//
// health のしきい値は central-mcp の定義に合わせる: Good 80-100 / Fair 50-79 / Poor 0-49。

const platformName = (p: string) => (p === "central" ? "Central" : "Mist");

function healthClass(health: number | null | undefined): string {
  if (health == null) return "none";
  if (health >= 80) return "good";
  if (health >= 50) return "fair";
  return "poor";
}

export function SiteList({
  entries,
  siteStatus,
  selectedSite,
  onSelectSite,
}: {
  entries: SiteEntry[];
  siteStatus: SiteStatusFile;
  selectedSite: string;
  onSelectSite: (siteName: string) => void;
}) {
  // Central → Mist、その中はサイト名昇順で並べる。
  const sorted = useMemo(() => {
    const order: Record<string, number> = { central: 0, mist: 1 };
    return [...entries].sort(
      (a, b) =>
        (order[a.platform] ?? 9) - (order[b.platform] ?? 9) ||
        a.siteName.localeCompare(b.siteName, "ja"),
    );
  }, [entries]);

  if (sorted.length === 0) {
    return <div className="ni-empty">サイト対応表がまだありません。</div>;
  }

  return (
    <div className="ni-sitelist" role="list">
      {sorted.map((e) => {
        const st = siteStatus.statuses[e.siteId];
        const selected = selectedSite === e.siteName;
        return (
          <button
            key={`${e.platform}-${e.siteId}`}
            type="button"
            role="listitem"
            className={`ni-site-row${selected ? " selected" : ""}`}
            onClick={() => onSelectSite(e.siteName)}
            title={`${e.siteName}(${platformName(e.platform)} 管理 / siteId=${e.siteId})をクエリ対象にする`}
          >
            <LogoBadge target={e.platform} size={18} title={platformName(e.platform)} />
            <span className="ni-site-name">{e.siteName}</span>
            {st ? (
              <span className="ni-site-metrics ni-mono">
                <span className={`ni-health ${healthClass(st.health)}`}>
                  health {st.health ?? "–"}
                </span>
                <span className="ni-dim">dev {st.devices ?? "–"}</span>
                <span className="ni-dim">cli {st.clients ?? "–"}</span>
                <span className={st.alerts ? "ni-site-alerts" : "ni-dim"}>alert {st.alerts ?? "–"}</span>
              </span>
            ) : (
              <span className="ni-site-metrics ni-mono ni-dim">状態未取得</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
