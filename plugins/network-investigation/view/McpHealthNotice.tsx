import { useT, type TFunc } from "../../../src/i18n";
import { LogoBadge } from "./LogoBadge";
import type { McpHealth, McpServerHealth } from "./types";

// MCP サーバーに接続できなかったことを示す警告バナー(09)。
//
// 08 3-5 で残した穴への対応。MCP サーバーの認証が切れていると、claude CLI は
// ハンドシェイク段階で失敗してそのサーバーのツールを 1 つも登録しないまま
// 「成功」で終わるため、従来は画面に何も出なかった(モデルの地の文で
// 「ツールが見つかりません」と書かれるだけ)。
//
// 表示の強さは 2 段階にしている:
//   - unreachable … 直接ハンドシェイクしても到達できなかった(= 断定できる)。赤。
//   - warn        … 到達確認ができなかった / claude 側だけが失敗と言っている。アンバー。
// 回答自体は返っているので「失敗」ではなく警告に留める(誤検知の実害を小さくする)。

const platformName = (t: TFunc, p: string | null) =>
  p === "central" ? "Central" : p === "mist" ? "Mist" : t("networkInvestigation.mcpHealth.platformUnknown");

function serverLine(t: TFunc, s: McpServerHealth): string {
  return s.level === "unreachable"
    ? t("networkInvestigation.mcpHealth.stateUnreachable")
    : t("networkInvestigation.mcpHealth.stateUnknown");
}

export function mcpHealthTagLabel(t: TFunc, level: McpHealth["level"]): string | null {
  if (level === "unreachable") return t("networkInvestigation.mcpHealth.tagUnreachable");
  if (level === "warn") return t("networkInvestigation.mcpHealth.tagWarn");
  return null;
}

export function McpHealthNotice({ health }: { health: McpHealth | null | undefined }) {
  const t = useT();
  if (!health || health.level === "ok" || health.problems.length === 0) return null;

  const unreachable = health.level === "unreachable";
  return (
    <div className={`ni-mcp-health ${health.level}`}>
      <div className="ni-mcp-health-head">
        <span aria-hidden>⚠</span>
        <span>
          {unreachable
            ? t("networkInvestigation.mcpHealth.headUnreachable")
            : t("networkInvestigation.mcpHealth.headWarn")}
        </span>
      </div>
      {health.problems.map((s) => (
        <div className="ni-mcp-health-item" key={s.server}>
          <div className="ni-mcp-health-item-head">
            <LogoBadge target={s.server} size={18} skipped title={s.server} />
            <span className="ni-mono">
              {t("networkInvestigation.mcpHealth.serverLine", {
                server: s.server,
                platform: platformName(t, s.platform),
              })}
            </span>
            <span className={`ni-mcp-health-state ${s.level}`}>{serverLine(t, s)}</span>
          </div>
          {s.reason && <div className="ni-mono ni-mcp-health-reason">{s.reason}</div>}
          <div className="ni-mono ni-dim ni-mcp-health-note">
            {t("networkInvestigation.mcpHealth.note", {
              server: s.server,
              init:
                s.initStatus !== "unknown"
                  ? t("networkInvestigation.mcpHealth.noteInit", { status: s.initStatus })
                  : "",
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
