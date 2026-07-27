import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// 回答本文の ```chart ブロックを recharts で描画する(Task 2)。
// スペックは { type: "bar"|"line"|"pie", title, data: [{ label, value }] }。
// 不正な JSON / 想定外の type はそのまま生テキストのコードブロックとして見せる(壊さない)。
//
// アニメーションは全系列で無効化する(04b)。印刷 / 共有(printClone.ts)は画面に描画済みの
// SVG をそのまま複製するため、初期表示・再マウントのアニメーション途中(既定 0.4〜1.5s、
// 非表示タブでは rAF が止まり無期限)に複製すると、伸びかけのグラフが紙面に固定される。
// 完了待ちの仕組みを入れるより、常に完成形で即描画させる方が安い。

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  data: Array<{ label: string; value: number }>;
}

const PALETTE = ["#ff8a3d", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#f43f5e"];
const AXIS = "#8a93a3";
const GRID = "rgba(140,150,165,0.18)";

// ```chart の中身(生テキスト)を検証して ChartSpec へ。失敗なら null。
export function parseChartSpec(raw: string): ChartSpec | null {
  try {
    const p = JSON.parse((raw || "").trim());
    if (!p || typeof p !== "object") return null;
    const type = p.type;
    if (type !== "bar" && type !== "line" && type !== "pie") return null;
    if (!Array.isArray(p.data)) return null;
    const data = p.data
      .map((d: any) => ({ label: String(d?.label ?? ""), value: Number(d?.value) }))
      .filter((d: { label: string; value: number }) => d.label && Number.isFinite(d.value));
    if (!data.length) return null;
    return { type, title: typeof p.title === "string" ? p.title : undefined, data };
  } catch {
    return null;
  }
}

function tooltipStyle() {
  return {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    fontSize: 12,
  } as const;
}

// richIndex: 同じ回答内での chart ブロックの通し番号(Markdown.tsx が振る)。
// 印刷時に「N 番目のグラフの SVG」を突き合わせて複製するための目印(printClone.ts)。
export function Chart({ spec, richIndex }: { spec: ChartSpec; richIndex?: number }) {
  const data = spec.data;
  const body = useMemo(() => {
    if (spec.type === "pie") {
      return (
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" outerRadius="80%" label isAnimationActive={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle()} />
          <Legend wrapperStyle={{ fontSize: 12, color: AXIS }} />
        </PieChart>
      );
    }
    if (spec.type === "line") {
      return (
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} />
          <YAxis stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle()} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={PALETTE[0]}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      );
    }
    return (
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="label" stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} />
        <YAxis stroke={AXIS} tick={{ fontSize: 11, fill: AXIS }} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle()} cursor={{ fill: "rgba(140,150,165,0.08)" }} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    );
  }, [spec.type, data]);

  return (
    <div className="ni-chart" data-ni-rich="chart" data-ni-index={richIndex}>
      {spec.title && <div className="ni-chart-title">{spec.title}</div>}
      <div className="ni-chart-canvas">
        <ResponsiveContainer width="100%" height="100%">
          {body}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
