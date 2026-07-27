// デバイス種別ごとの Up/Down ドーナツ。
//
// recharts は既存依存(network-investigation の Chart.tsx が使用)。
// アニメーションは 04b と同じ理由で全系列オフにする(初期表示を常に完成形にする)。
//
// 総数 0 の種別は Pie に渡すデータが空になり recharts が何も描かないため、
// 「グレーの輪」を自前で出して「0 台」であることを明示する(欠測ではない)。

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { DeviceCounts } from "./types";

export const UP_COLOR = "#22c55e";
export const DOWN_COLOR = "#ef4444";

export function Donut({
  label,
  counts,
  size = 104,
}: {
  label: string;
  counts: DeviceCounts;
  size?: number;
}) {
  const empty = counts.total === 0;
  const data = empty
    ? []
    : [
        { name: "Up", value: counts.up, color: UP_COLOR },
        { name: "Down", value: counts.down, color: DOWN_COLOR },
      ].filter((d) => d.value > 0);

  const outer = size / 2 - 4;
  const inner = outer * 0.64;

  return (
    <div className="go-donut" style={{ width: size }}>
      <div className="go-donut-chart" style={{ width: size, height: size }}>
        {empty ? (
          <div
            className="go-donut-empty"
            style={{ width: outer * 2, height: outer * 2, borderWidth: outer - inner }}
            aria-hidden
          />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={inner}
                outerRadius={outer}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={false}
              >
                {data.map((d) => (
                  <Cell key={d.name} fill={d.color} />
                ))}
              </Pie>
              <Tooltip
                isAnimationActive={false}
                contentStyle={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 12,
                }}
                itemStyle={{ color: "var(--text)" }}
                formatter={(v, n) => [`${v} 台`, String(n)] as [string, string]}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
        <div className="go-donut-center">
          <span className="go-donut-total">{counts.total}</span>
        </div>
      </div>
      <div className="go-donut-label">{label}</div>
      <div className="go-donut-sub">
        <span className="go-up">{counts.up} Up</span>
        <span className="go-sep">/</span>
        <span className={counts.down > 0 ? "go-down" : "go-zero"}>{counts.down} Down</span>
      </div>
    </div>
  );
}
