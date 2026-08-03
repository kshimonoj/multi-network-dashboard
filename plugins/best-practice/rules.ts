/**
 * ベストプラクティス診断のルールカタログ(49_findings.md §3-3 / §3-4 の設計をそのまま型に落としたもの)。
 *
 * 数え方について(49 番の表との対応):
 *   49 §3-3 セキュリティ = SEC-01〜SEC-13(機械 11 + LLM 2 = 13 件)
 *   49 §3-4 RF          = RF-01〜RF-16(機械 14 + LLM 2)。49 の本文は
 *                          「機械 12 + LLM 2 = 14 件」と数えているが、表の行は
 *                          RF-01〜RF-14 の 14 行 + LLM 2 行で 16 行ある。
 *                          ここでは **表に載っている ID をすべて実装**し、合計 29 ID とする
 *                          (51 番の「全 27 項目」を欠けなく含む)。
 *
 * 拡張のしかた(49 §3-2 の手順):
 *   CheckCategory に文字列を足す → ここに BestPracticeRule を 1 件追加する →
 *   evaluate.ts の EVALUATORS にルール ID を登録する →
 *   ja.json / en.json に titleKey / descriptionKey / messageCode を追加する。
 *
 * 根拠 URL(references)は必須。**出典タイトルと URL は翻訳しない**(49 §4-4)。
 */

import type { BestPracticeRule, RuleReference } from "./types.js";

// ── 根拠ドキュメント(49 §6)────────────────────────────────
const REF_SECURITY_MODES: RuleReference = {
  title: "Security modes",
  url: "https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/",
};
const REF_PMF: RuleReference = {
  title: "Protected management frames",
  url: "https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/",
};
const REF_SSID_PROFILE_CLI: RuleReference = {
  title: "wlan ssid-profile (CLI-Bank / Instant)",
  url: "https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/instant/wlan-ssid-prof.htm",
};
const REF_WIDS_DETECTION: RuleReference = {
  title: "WIDS/WIPS — Detection",
  url: "https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/detection/",
};
const REF_WIDS_PROTECTION: RuleReference = {
  title: "WIDS/WIPS — Protection",
  url: "https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/wids-wips/protection/",
};
const REF_RF_DESIGN: RuleReference = {
  title: "RF Design (Validated Solution Guide)",
  url: "https://arubanetworking.hpe.com/techdocs/VSG/docs/010-campus-design/esp-campus-design-047-rf-design/",
};
const REF_RF_PLANNING: RuleReference = {
  title: "Radio frequency planning and channel optimization (LPV)",
  url: "https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/design-guides/lpv/rf-planning/",
};
const REF_AIRMATCH: RuleReference = {
  title: "AirMatch (AOS 10)",
  url: "https://arubanetworking.hpe.com/techdocs/aos/aos10/services/airmatch/",
};

const SHOW_RUNNING = { kind: "central-show", command: "show running-config" } as const;
const SHOW_RADIO = { kind: "central-show", command: "show radio config" } as const;
const SHOW_IDS_DETECT = { kind: "central-show", command: "show ids-detection config" } as const;
const SHOW_IDS_PROTECT = { kind: "central-show", command: "show ids-protection config" } as const;
const SHOW_ARM = { kind: "central-show", command: "show arm config" } as const;
const MCP_APS = { kind: "central-mcp", tool: "central_get_aps" } as const;
const MCP_AP_DETAILS = { kind: "central-mcp", tool: "central_get_ap_details" } as const;
const MIST_WLANS = { kind: "mist-config", resourceType: "wlans" } as const;
const MIST_RFTEMPLATES = { kind: "mist-config", resourceType: "rftemplates" } as const;
const MIST_DEVICES = { kind: "mist-stats", statsType: "org_devices" } as const;

function key(id: string, part: "title" | "desc"): string {
  return `bestPractice.rules.${id}.${part}`;
}

function rule(r: Omit<BestPracticeRule, "titleKey" | "descriptionKey">): BestPracticeRule {
  return { ...r, titleKey: key(r.id, "title"), descriptionKey: key(r.id, "desc") };
}

// ── セキュリティ(SEC-01〜SEC-13)────────────────────────────

const SECURITY_RULES: BestPracticeRule[] = [
  rule({
    id: "SEC-01",
    category: "security",
    platform: "both",
    target: "ssid",
    severity: "must",
    method: "mechanical",
    references: [REF_SECURITY_MODES],
    sources: [SHOW_RUNNING, MIST_WLANS],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-02",
    category: "security",
    platform: "both",
    target: "ssid",
    severity: "strong",
    method: "mechanical",
    references: [REF_SECURITY_MODES],
    sources: [SHOW_RUNNING, MIST_WLANS],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-03",
    category: "security",
    platform: "both",
    target: "ssid",
    severity: "strong",
    method: "mechanical",
    references: [REF_SECURITY_MODES],
    sources: [SHOW_RUNNING, MIST_WLANS],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-04",
    category: "security",
    platform: "central",
    target: "ssid",
    severity: "strong",
    method: "mechanical",
    references: [REF_PMF, REF_SSID_PROFILE_CLI],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-05",
    category: "security",
    platform: "central",
    target: "ssid",
    severity: "advisory",
    method: "mechanical",
    references: [REF_SECURITY_MODES, REF_SSID_PROFILE_CLI],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-06",
    category: "security",
    platform: "both",
    target: "ssid",
    severity: "must",
    method: "mechanical",
    references: [REF_SECURITY_MODES],
    sources: [SHOW_RUNNING, MIST_WLANS],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-07",
    category: "security",
    platform: "central",
    target: "ap",
    severity: "strong",
    method: "mechanical",
    references: [REF_WIDS_DETECTION],
    sources: [SHOW_IDS_DETECT, SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-08",
    category: "security",
    platform: "central",
    target: "ap",
    severity: "strong",
    method: "mechanical",
    references: [REF_WIDS_DETECTION],
    sources: [SHOW_IDS_DETECT, SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-09",
    category: "security",
    platform: "central",
    target: "ap",
    severity: "advisory",
    method: "mechanical",
    references: [REF_WIDS_DETECTION],
    sources: [SHOW_IDS_DETECT, SHOW_RUNNING],
    enabledByDefault: true,
  }),
  // SEC-10 / SEC-11 は封じ込め系。**無効を fail にしない**(49 §3-5)。
  // 有効になっていることを検知して、法務・セキュリティ部門の承認確認を促す向きに統一する。
  rule({
    id: "SEC-10",
    category: "security",
    platform: "central",
    target: "ap",
    severity: "advisory",
    method: "mechanical",
    references: [REF_WIDS_PROTECTION],
    sources: [SHOW_IDS_PROTECT, SHOW_RUNNING],
    requiresLegalReview: true,
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-11",
    category: "security",
    platform: "central",
    target: "ap",
    severity: "advisory",
    method: "mechanical",
    references: [REF_WIDS_PROTECTION],
    sources: [SHOW_IDS_PROTECT],
    requiresLegalReview: true,
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-12",
    category: "security",
    platform: "both",
    target: "site",
    severity: "advisory",
    method: "llm",
    references: [REF_SECURITY_MODES],
    sources: [{ kind: "derived" }],
    enabledByDefault: true,
  }),
  rule({
    id: "SEC-13",
    category: "security",
    platform: "both",
    target: "site",
    severity: "advisory",
    method: "llm",
    references: [REF_SECURITY_MODES],
    sources: [{ kind: "derived" }],
    enabledByDefault: true,
  }),
];

// ── RF / 無線チューニング(RF-01〜RF-16)──────────────────────

const RF_RULES: BestPracticeRule[] = [
  rule({
    id: "RF-01",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "strong",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RADIO, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-02",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RADIO, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-03",
    category: "rf",
    platform: "both",
    target: "site",
    severity: "strong",
    method: "mechanical",
    references: [REF_RF_PLANNING],
    sources: [MCP_AP_DETAILS, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-04",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_PLANNING],
    sources: [SHOW_RADIO, SHOW_ARM, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-05",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RADIO, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-06",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RADIO, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-07",
    category: "rf",
    platform: "both",
    target: "radio",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RADIO, MIST_RFTEMPLATES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-08",
    category: "rf",
    platform: "central",
    target: "ssid",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-09",
    category: "rf",
    platform: "central",
    target: "ssid",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-10",
    category: "rf",
    platform: "central",
    target: "ssid",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-11",
    category: "rf",
    platform: "central",
    target: "ssid",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RUNNING],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-12",
    category: "rf",
    platform: "central",
    target: "ssid",
    severity: "advisory",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_RUNNING, SHOW_RADIO],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-13",
    category: "rf",
    platform: "central",
    target: "ap",
    severity: "recommended",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [SHOW_ARM],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-14",
    category: "rf",
    platform: "both",
    target: "site",
    severity: "advisory",
    method: "mechanical",
    references: [REF_RF_DESIGN],
    sources: [MCP_APS, MIST_DEVICES],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-15",
    category: "rf",
    platform: "both",
    target: "site",
    severity: "advisory",
    method: "llm",
    references: [REF_RF_PLANNING, REF_RF_DESIGN],
    sources: [{ kind: "derived" }],
    enabledByDefault: true,
  }),
  rule({
    id: "RF-16",
    category: "rf",
    platform: "both",
    target: "site",
    severity: "advisory",
    method: "llm",
    references: [REF_AIRMATCH],
    sources: [{ kind: "derived" }],
    enabledByDefault: true,
  }),
];

export const RULES: BestPracticeRule[] = [...SECURITY_RULES, ...RF_RULES];

const BY_ID = new Map(RULES.map((r) => [r.id, r]));

export function getRule(id: string): BestPracticeRule | undefined {
  return BY_ID.get(id);
}

/** そのプラットフォームで実行するルール(platform:"both" を含む) */
export function rulesForPlatform(platform: "central" | "mist"): BestPracticeRule[] {
  return RULES.filter((r) => r.platform === platform || r.platform === "both");
}

export function ruleCounts(): {
  total: number;
  mechanical: number;
  llm: number;
  security: number;
  rf: number;
} {
  return {
    total: RULES.length,
    mechanical: RULES.filter((r) => r.method === "mechanical").length,
    llm: RULES.filter((r) => r.method === "llm").length,
    security: RULES.filter((r) => r.category === "security").length,
    rf: RULES.filter((r) => r.category === "rf").length,
  };
}
