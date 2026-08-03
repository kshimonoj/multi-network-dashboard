// レポートタブ(43 Task 3)— トレンドグラフ 2 種。
//
// 日次レポート 1 日ぶんには「推移」と呼べる点が無い(当日の平均が 1 点あるだけ)ので、
// 選んだ日を右端として **直近 N 日ぶんの日次レポートを並べて** 折れ線 / 棒にする
// (週次 / 月次の本実装が入る 44 番までの代替。Task 3-4 の指定)。
//
// 健全性 / SLE は「New Central の平均健全性」と「Mist の平均 SLE」を **1 枚に 2 系列** で出す。
// どちらも 0〜100 の同じスケールなので軸を分けない。サイト別・Wireless/Wired 等の内訳は
// このグラフでは出さず、既存の Global Overview サイト詳細ページへのリンクで代替する
// (グラフ下の注記 + サイトチップ)。

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useT } from "../../../src/i18n/LanguageContext";
import { formatAxisDay } from "./dates";
import type { DailyReport } from "./types";

const CENTRAL = "#ff8a3d";
const MIST = "#22c55e";
const CLIENTS = "#4fd1c5";
const AXIS = "#8a93a3";
const GRID = "rgba(140,150,165,0.18)";

export interface TrendPoint {
  date: string;
  label: string;
  centralHealth: number | null;
  mistSle: number | null;
  clients: number | null;
  /** その日のサイト数(平均の母数として tooltip に出す) */
  centralSites: number;
  mistSites: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** 日次レポート(昇順)→ グラフ用の点列。 */
export function toTrendPoints(reports: DailyReport[]): TrendPoint[] {
  return reports.map((r) => {
    const sites = r.data.overview.sites;
    const central = sites
      .filter((s) => s.platform === "central" && typeof s.centralHealth?.avg === "number")
      .map((s) => s.centralHealth!.avg as number);
    const mist = sites
      .filter((s) => s.platform === "mist" && typeof s.mistSle?.avg === "number")
      .map((s) => s.mistSle!.avg as number);
    const clients = r.data.overview.totals.clients.avg;
    return {
      date: r.date,
      label: formatAxisDay(r.date),
      centralHealth: mean(central),
      mistSle: mean(mist),
      clients: typeof clients === "number" ? Math.round(clients) : null,
      centralSites: central.length,
      mistSites: mist.length,
    };
  });
}

function tooltipStyle() {
  return {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    fontSize: 12,
  } as const;
}

/** 平均健全性(Central)/ 平均 SLE(Mist)。0〜100 の 1 枚 2 系列。 */
export function HealthTrend({ points }: { points: TrendPoint[] }) {
  const t = useT();
  const hasCentral = points.some((p) => p.centralHealth !== null);
  const hasMist = points.some((p) => p.mistSle !== null);

  if (points.length === 0) {
    return <div className="rp-chart-empty">{t("reports.charts.noData")}</div>;
  }
  return (
    <div className="rp-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 14, bottom: 4, left: -14 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} />
          <YAxis domain={[0, 100]} stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} width={44} />
          <Tooltip contentStyle={tooltipStyle()} isAnimationActive={false} />
          <Legend wrapperStyle={{ fontSize: 11, color: AXIS }} />
          {hasCentral && (
            <Line
              type="monotone"
              dataKey="centralHealth"
              name={t("reports.charts.centralHealth")}
              stroke={CENTRAL}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          )}
          {hasMist && (
            <Line
              type="monotone"
              dataKey="mistSle"
              name={t("reports.charts.mistSle")}
              stroke={MIST}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 利用量トレンド = 接続端末数の推移。トラフィック量は取得経路が無いので出さない。 */
export function ClientsTrend({ points }: { points: TrendPoint[] }) {
  const t = useT();
  if (points.length === 0) {
    return <div className="rp-chart-empty">{t("reports.charts.noData")}</div>;
  }
  return (
    <div className="rp-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 14, bottom: 4, left: -14 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} />
          <YAxis stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} allowDecimals={false} width={44} />
          <Tooltip
            contentStyle={tooltipStyle()}
            cursor={{ fill: "rgba(140,150,165,0.08)" }}
            isAnimationActive={false}
          />
          <Bar
            dataKey="clients"
            name={t("reports.charts.clients")}
            fill={CLIENTS}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
