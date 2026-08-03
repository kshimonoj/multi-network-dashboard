/**
 * 判定エンジン(機械判定)。
 *
 * 方針(49 §3-1):
 *  1. **サーバは文章を作らない。** 判定結果は messageCode + messageParams で返し、
 *     画面側の辞書で文にする。observed には素材(値)だけを入れる。
 *  2. 「取得できなかった」と「値が 0 だった」を混同しない。前者は必ず `unknown`。
 *  3. 封じ込め系(SEC-10 / SEC-11)は**無効を fail にしない**。有効であることを検知して
 *     法務・セキュリティ部門の承認確認を促す(requiresLegalReview)。
 *
 * messageCode は `bestPractice.findings.<ruleId>.<case>`。
 * UI 実装時に ja.json / en.json の**両方**へ追加すること(49 §4-4)。
 */

import type {
  ApRadioMeta,
  Band,
  CentralSiteSnapshot,
  Finding,
  FindingStatus,
  MistSiteSnapshot,
  ObservedValue,
  RadioProfileConfig,
  SsidProfileConfig,
} from "./types.js";
import { classifyOpmode, evaluateSec04, evaluateSec05 } from "./pmf.js";
import { getRule } from "./rules.js";

interface Ctx {
  platform: "central" | "mist";
  siteId: string;
  siteName: string;
  collectedAt: string;
  /** UI で無効化されたルール */
  disabled: Set<string>;
}

function mk(
  ctx: Ctx,
  args: {
    ruleId: string;
    status: FindingStatus;
    targetType: Finding["targetType"];
    targetId: string;
    targetLabel: string;
    observed: Record<string, ObservedValue>;
    messageCode: string;
    messageParams?: Record<string, string | number>;
  },
): Finding {
  const rule = getRule(args.ruleId);
  return {
    ruleId: args.ruleId,
    status: args.status,
    platform: ctx.platform,
    targetType: args.targetType,
    targetId: args.targetId,
    targetLabel: args.targetLabel,
    siteId: ctx.siteId,
    observed: args.observed,
    messageCode: args.messageCode,
    messageParams: args.messageParams ?? {},
    collectedAt: ctx.collectedAt,
    ...(rule?.requiresLegalReview ? { requiresLegalReview: true } : {}),
  };
}

function code(ruleId: string, c: string): string {
  return `bestPractice.findings.${ruleId}.${c}`;
}

/** 2.4GHz の非重複チャネル(RF-04) */
const NON_OVERLAPPING_24 = new Set(["1", "6", "11"]);

/** SEC-11 が法務確認を促す高リスクな保護ポリシー(49 §3-3) */
const HIGH_RISK_PROTECTION_POLICIES = [
  "rogue-containment",
  "protect-ssid",
  "protect-ap-impersonation",
  "protect-valid-sta",
  "protect-windows-bridge",
  "protect-wifi-direct-p2p-groups",
  "protect-adhoc-network",
];

/** AP モデル名から系列(AP-5xx / AP-6xx …)を取り出す。RF-14 の混在判定に使う */
export function apSeries(model: string): string | null {
  const m = /(\d)\d{2}/.exec(model.replace(/[^A-Za-z0-9-]/g, ""));
  if (m) return `${m[1]}xx`;
  return null;
}

// ── セキュリティ: SSID 単位(Central)────────────────────────

function ssidTarget(serial: string, ssid: SsidProfileConfig) {
  return {
    targetType: "ssid" as const,
    targetId: `${serial}:${ssid.name}`,
    targetLabel: ssid.essid ?? ssid.name,
  };
}

function sec01Central(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const family = classifyOpmode(ssid.opmode);
  const m = (ssid.opmode ?? "").toLowerCase();
  let status: FindingStatus;
  let c: string;

  if (family === "unknown") {
    status = "unknown";
    c = "opmodeUnknown";
  } else if (m.includes("wep")) {
    status = "fail";
    c = "wep";
  } else if (m.includes("tkip")) {
    status = "fail";
    c = "tkip";
  } else if (m === "opensystem") {
    status = "fail";
    c = "open";
  } else {
    status = "pass";
    c = "ok";
  }

  return mk(ctx, {
    ruleId: "SEC-01",
    status,
    ...ssidTarget(serial, ssid),
    observed: { opmode: ssid.opmode, opmodeFamily: family, enabled: ssid.enabled },
    messageCode: code("SEC-01", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, opmode: ssid.opmode ?? "" },
  });
}

function sec02Central(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const family = classifyOpmode(ssid.opmode);
  const m = (ssid.opmode ?? "").toLowerCase();
  let status: FindingStatus;
  let c: string;

  if (family === "unknown") {
    status = "unknown";
    c = "opmodeUnknown";
  } else if (family === "enhanced-open") {
    status = "pass";
    c = "owe";
  } else if (m === "opensystem") {
    status = "warn";
    c = "openNotOwe";
  } else {
    status = "not_applicable";
    c = "notOpen";
  }

  return mk(ctx, {
    ruleId: "SEC-02",
    status,
    ...ssidTarget(serial, ssid),
    observed: { opmode: ssid.opmode, opmodeFamily: family, enabled: ssid.enabled },
    messageCode: code("SEC-02", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, opmode: ssid.opmode ?? "" },
  });
}

function sec03Central(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const family = classifyOpmode(ssid.opmode);
  let status: FindingStatus;
  let c: string;

  if (family === "unknown") {
    status = "unknown";
    c = "opmodeUnknown";
  } else if (family === "wpa2") {
    status = "warn";
    c = "wpa2";
  } else if (family === "wpa3-transitionable" || family === "wpa3-always-pmf") {
    status = "pass";
    c = "wpa3";
  } else if (family === "enhanced-open") {
    status = "pass";
    c = "owe";
  } else {
    // legacy は SEC-01 が扱う
    status = "not_applicable";
    c = "legacy";
  }

  return mk(ctx, {
    ruleId: "SEC-03",
    status,
    ...ssidTarget(serial, ssid),
    observed: { opmode: ssid.opmode, opmodeFamily: family, enabled: ssid.enabled },
    messageCode: code("SEC-03", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, opmode: ssid.opmode ?? "" },
  });
}

function sec06Central(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const family = classifyOpmode(ssid.opmode);
  const uses6 = ssid.bands.includes("6");
  const ok = family === "wpa3-transitionable" || family === "wpa3-always-pmf" || family === "enhanced-open";

  let status: FindingStatus;
  let c: string;
  if (!uses6) {
    status = "not_applicable";
    c = "no6ghz";
  } else if (family === "unknown") {
    status = "unknown";
    c = "opmodeUnknown";
  } else if (ok) {
    status = "pass";
    c = "ok";
  } else {
    status = "fail";
    c = "notWpa3";
  }

  return mk(ctx, {
    ruleId: "SEC-06",
    status,
    ...ssidTarget(serial, ssid),
    observed: {
      opmode: ssid.opmode,
      opmodeFamily: family,
      bands: ssid.bands.join(","),
      enabled: ssid.enabled,
    },
    messageCode: code("SEC-06", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, opmode: ssid.opmode ?? "" },
  });
}

// ── セキュリティ: WIDS/WIPS(Central・AP 単位)─────────────

function detectionLevelFinding(
  ctx: Ctx,
  ruleId: "SEC-07" | "SEC-08",
  serial: string,
  apName: string,
  level: string | null,
  source: string,
): Finding {
  let status: FindingStatus;
  let c: string;
  if (level === null) {
    status = "unknown";
    c = "notCollected";
  } else if (level === "off") {
    status = "fail";
    c = "off";
  } else {
    status = "pass";
    c = "enabled";
  }

  return mk(ctx, {
    ruleId,
    status,
    targetType: "ap",
    targetId: serial,
    targetLabel: apName,
    observed: { level, source },
    messageCode: code(ruleId, c),
    messageParams: { ap: apName, level: level ?? "" },
  });
}

function sec09(
  ctx: Ctx,
  serial: string,
  apName: string,
  infra: string | null,
  client: string | null,
): Finding {
  const levels = [infra, client].filter((v): v is string => v !== null);
  const elevated = levels.filter((l) => l === "medium" || l === "high");

  let status: FindingStatus;
  let c: string;
  if (levels.length === 0) {
    status = "unknown";
    c = "notCollected";
  } else if (elevated.length > 0) {
    status = "warn";
    c = "elevated";
  } else if (levels.every((l) => l === "off")) {
    // SEC-07 / SEC-08 が扱う
    status = "not_applicable";
    c = "off";
  } else {
    status = "pass";
    c = "low";
  }

  return mk(ctx, {
    ruleId: "SEC-09",
    status,
    targetType: "ap",
    targetId: serial,
    targetLabel: apName,
    observed: { infrastructureLevel: infra, clientLevel: client },
    messageCode: code("SEC-09", c),
    messageParams: { ap: apName, levels: elevated.join(",") },
  });
}

function sec10(
  ctx: Ctx,
  serial: string,
  apName: string,
  wireless: string | null,
  wired: string | null,
  source: string,
): Finding {
  let status: FindingStatus;
  let c: string;
  if (wireless === null) {
    status = "unknown";
    c = "notCollected";
  } else if (wireless.toLowerCase() !== "none") {
    // 「有効になっている」ことを検知して法務確認を促す。無効を問題として扱わない(49 §3-5)
    status = "warn";
    c = "enabled";
  } else {
    status = "pass";
    c = "disabled";
  }

  return mk(ctx, {
    ruleId: "SEC-10",
    status,
    targetType: "ap",
    targetId: serial,
    targetLabel: apName,
    observed: { wirelessContainment: wireless, wiredContainment: wired, source },
    messageCode: code("SEC-10", c),
    messageParams: { ap: apName, mode: wireless ?? "" },
  });
}

function sec11(ctx: Ctx, serial: string, apName: string, enabled: string[] | null): Finding {
  let status: FindingStatus;
  let c: string;
  let hits: string[] = [];

  if (enabled === null) {
    status = "unknown";
    c = "notCollected";
  } else {
    hits = enabled.filter((p) => HIGH_RISK_PROTECTION_POLICIES.includes(p));
    if (hits.length > 0) {
      status = "warn";
      c = "enabled";
    } else {
      status = "pass";
      c = "none";
    }
  }

  return mk(ctx, {
    ruleId: "SEC-11",
    status,
    targetType: "ap",
    targetId: serial,
    targetLabel: apName,
    // ポリシー名は「値」なので observed に文字列連結で載せる(文章にはしない)
    observed: { enabledPolicies: hits.join(","), enabledCount: hits.length },
    messageCode: code("SEC-11", c),
    messageParams: { ap: apName, policies: hits.join(", "), count: hits.length },
  });
}

// ── RF: 無線単位(Central)───────────────────────────────────

function radioTarget(serial: string, radio: RadioProfileConfig) {
  return {
    targetType: "radio" as const,
    targetId: `${serial}:${radio.section}`,
    targetLabel: `${serial} ${radio.section}GHz`,
  };
}

function rf01(ctx: Ctx, serial: string, radio: RadioProfileConfig): Finding {
  const bw = radio.maxChannelBandwidthMhz;
  let status: FindingStatus;
  let c: string;
  if (bw === null) {
    status = "unknown";
    c = "notCollected";
  } else if (bw > 20) {
    status = "fail";
    c = "over20";
  } else {
    status = "pass";
    c = "ok";
  }
  return mk(ctx, {
    ruleId: "RF-01",
    status,
    ...radioTarget(serial, radio),
    observed: { band: radio.band, maxChannelBandwidthMhz: bw, section: radio.section },
    messageCode: code("RF-01", c),
    messageParams: { radio: radio.section, bandwidth: bw ?? "" },
  });
}

function rf02(ctx: Ctx, serial: string, radio: RadioProfileConfig): Finding {
  const bw = radio.maxChannelBandwidthMhz;
  let status: FindingStatus;
  let c: string;
  if (bw === null) {
    status = "unknown";
    c = "notCollected";
  } else if (bw > 80) {
    status = "warn";
    c = "over80";
  } else {
    status = "pass";
    c = "ok";
  }
  return mk(ctx, {
    ruleId: "RF-02",
    status,
    ...radioTarget(serial, radio),
    observed: { band: radio.band, maxChannelBandwidthMhz: bw, section: radio.section },
    messageCode: code("RF-02", c),
    messageParams: { radio: radio.section, bandwidth: bw ?? "" },
  });
}

/** `1` / `1+`(HT40)/ `36E`(80MHz)/ `36S`(160MHz)から基本チャネル番号を取り出す */
function baseChannel(ch: string): string | null {
  const m = /^(\d+)/.exec(ch.trim());
  return m ? m[1] : null;
}

function rf04(
  ctx: Ctx,
  serial: string,
  target: { targetType: "radio"; targetId: string; targetLabel: string },
  allowed: string[] | null,
  source: string,
): Finding {
  let status: FindingStatus;
  let c: string;
  let offenders: string[] = [];

  if (allowed === null) {
    status = "unknown";
    c = "notCollected";
  } else {
    // 20MHz の素のチャネルだけを見る(`1+` / `36E` はチャネル幅の話で RF-01 が扱う)
    const plain = allowed.filter((ch) => /^\d+$/.test(ch.trim()));
    offenders = plain.filter((ch) => {
      const b = baseChannel(ch);
      return b !== null && !NON_OVERLAPPING_24.has(b);
    });
    if (plain.length === 0) {
      status = "unknown";
      c = "notCollected";
    } else if (offenders.length > 0) {
      status = "warn";
      c = "overlapping";
    } else {
      status = "pass";
      c = "ok";
    }
  }

  return mk(ctx, {
    ruleId: "RF-04",
    status,
    ...target,
    observed: {
      allowedChannels: allowed ? allowed.join(",") : null,
      offenders: offenders.join(","),
      source,
    },
    messageCode: code("RF-04", c),
    messageParams: { channels: offenders.join(", ") },
  });
}

function rf05(ctx: Ctx, serial: string, radio: RadioProfileConfig): Finding {
  const { maxTxPower: max, minTxPower: min } = radio;
  let status: FindingStatus;
  let c: string;
  let diff: number | null = null;

  if (max === null || min === null) {
    status = "unknown";
    c = "notCollected";
  } else {
    diff = max - min;
    if (diff > 6) {
      status = "warn";
      c = "wideRange";
    } else {
      status = "pass";
      c = "ok";
    }
  }

  return mk(ctx, {
    ruleId: "RF-05",
    status,
    ...radioTarget(serial, radio),
    observed: { band: radio.band, maxTxPower: max, minTxPower: min, diff, section: radio.section },
    messageCode: code("RF-05", c),
    messageParams: { radio: radio.section, diff: diff ?? "" },
  });
}

/** RF-06 / RF-07 は帯域をまたぐので、サイト(代表 AP)単位で 1 件だけ出す */
function rfCrossBand(
  ctx: Ctx,
  ruleId: "RF-06" | "RF-07",
  serial: string,
  apName: string,
  lower: number | null,
  upper: number | null,
  labels: { lower: string; upper: string },
): Finding {
  let status: FindingStatus;
  let c: string;
  let delta: number | null = null;

  if (lower === null || upper === null) {
    status = "unknown";
    c = "notCollected";
  } else {
    delta = upper - lower;
    if (ruleId === "RF-06") {
      // 5GHz は 2.4GHz より 6dBm 以上高いことが推奨
      status = delta >= 6 ? "pass" : "warn";
      c = delta >= 6 ? "ok" : "tooClose";
    } else {
      // 6GHz は 5GHz 比で 0〜+3dBm
      const ok = delta >= 0 && delta <= 3;
      status = ok ? "pass" : "warn";
      c = ok ? "ok" : "outOfRange";
    }
  }

  return mk(ctx, {
    ruleId,
    status,
    targetType: "ap",
    targetId: serial,
    targetLabel: apName,
    observed: {
      lowerBand: labels.lower,
      upperBand: labels.upper,
      lowerMinTxPower: lower,
      upperMinTxPower: upper,
      delta,
    },
    messageCode: code(ruleId, c),
    messageParams: { delta: delta ?? "" },
  });
}

// ── RF: SSID 単位(Central)──────────────────────────────────

function rf08(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const rates = [...(ssid.aBasicRates ?? []), ...(ssid.gBasicRates ?? [])];
  const collected = ssid.aBasicRates !== null || ssid.gBasicRates !== null;
  const low = rates.filter((r) => r < 12);

  let status: FindingStatus;
  let c: string;
  if (!collected) {
    // 行が出ていない = 機種既定に委ねられている。既定値を断定できないので unknown
    status = "unknown";
    c = "notConfigured";
  } else if (low.length > 0) {
    status = "warn";
    c = "lowRates";
  } else {
    status = "pass";
    c = "ok";
  }

  return mk(ctx, {
    ruleId: "RF-08",
    status,
    ...ssidTarget(serial, ssid),
    observed: {
      aBasicRates: ssid.aBasicRates?.join(",") ?? null,
      gBasicRates: ssid.gBasicRates?.join(",") ?? null,
      lowest: rates.length ? Math.min(...rates) : null,
    },
    messageCode: code("RF-08", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, rates: low.join(", ") },
  });
}

function rfFlag(
  ctx: Ctx,
  ruleId: "RF-09" | "RF-10",
  serial: string,
  ssid: SsidProfileConfig,
  on: boolean,
): Finding {
  return mk(ctx, {
    ruleId,
    status: on ? "pass" : "warn",
    ...ssidTarget(serial, ssid),
    observed: { enabled: on, ssidEnabled: ssid.enabled },
    messageCode: code(ruleId, on ? "enabled" : "disabled"),
    messageParams: { ssid: ssid.essid ?? ssid.name },
  });
}

function rf11(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const bf = (ssid.broadcastFilter ?? "").toLowerCase();
  const bfOk = bf === "arp" || bf === "all";
  const raOk = ssid.broadcastFilterIpv6Ra;

  let status: FindingStatus;
  let c: string;
  if (bfOk && raOk) {
    status = "pass";
    c = "ok";
  } else if (!bfOk && !raOk) {
    status = "warn";
    c = "bothMissing";
  } else if (!bfOk) {
    status = "warn";
    c = "filterMissing";
  } else {
    status = "warn";
    c = "raMissing";
  }

  return mk(ctx, {
    ruleId: "RF-11",
    status,
    ...ssidTarget(serial, ssid),
    observed: { broadcastFilter: ssid.broadcastFilter, broadcastFilterIpv6Ra: raOk },
    messageCode: code("RF-11", c),
    messageParams: { ssid: ssid.essid ?? ssid.name, filter: ssid.broadcastFilter ?? "" },
  });
}

function rf12Ssid(ctx: Ctx, serial: string, ssid: SsidProfileConfig): Finding {
  const disabled: string[] = [];
  if (ssid.ehtDisable) disabled.push("extremely-high-throughput-disable");
  if (ssid.heDisable) disabled.push("high-efficiency-disable");

  return mk(ctx, {
    ruleId: "RF-12",
    status: disabled.length ? "warn" : "pass",
    ...ssidTarget(serial, ssid),
    observed: { disabledFeatures: disabled.join(","), scope: "ssid" },
    messageCode: code("RF-12", disabled.length ? "ssidDisabled" : "ok"),
    messageParams: { ssid: ssid.essid ?? ssid.name, features: disabled.join(", ") },
  });
}

function rf12Radio(ctx: Ctx, serial: string, radio: RadioProfileConfig): Finding {
  const off: string[] = [];
  const check: Array<[string, boolean | null]> = [
    ["HE MU-OFDMA", radio.heMuOfdma],
    ["HE MU-MIMO", radio.heMuMimo],
    ["HE TxBF", radio.heTxBf],
    ["EHT MU-OFDMA", radio.ehtMuOfdma],
    ["EHT MU-MIMO", radio.ehtMuMimo],
    ["EHT TxBF", radio.ehtTxBf],
  ];
  const collected = check.some(([, v]) => v !== null);
  for (const [name, v] of check) if (v === false) off.push(name);

  let status: FindingStatus;
  let c: string;
  if (!collected) {
    status = "unknown";
    c = "notCollected";
  } else if (off.length) {
    status = "warn";
    c = "radioDisabled";
  } else {
    status = "pass";
    c = "ok";
  }

  return mk(ctx, {
    ruleId: "RF-12",
    status,
    ...radioTarget(serial, radio),
    observed: { disabledFeatures: off.join(","), scope: "radio", section: radio.section },
    messageCode: code("RF-12", c),
    messageParams: { radio: radio.section, features: off.join(", ") },
  });
}

// ── RF: サイト単位 ──────────────────────────────────────────

function rf03Central(ctx: Ctx, radios: ApRadioMeta[]): Finding[] {
  const bands: Band[] = ["2.4", "5", "6"];
  const out: Finding[] = [];

  for (const band of bands) {
    const inBand = radios.filter((r) => r.band === band && r.bandwidthMhz !== null);
    if (radios.filter((r) => r.band === band).length === 0) continue;

    const widths = [...new Set(inBand.map((r) => r.bandwidthMhz as number))].sort((a, b) => a - b);
    let status: FindingStatus;
    let c: string;
    if (inBand.length === 0) {
      status = "unknown";
      c = "notCollected";
    } else if (widths.length > 1) {
      status = "warn";
      c = "inconsistent";
    } else {
      status = "pass";
      c = "ok";
    }

    out.push(
      mk(ctx, {
        ruleId: "RF-03",
        status,
        targetType: "site",
        targetId: `${ctx.siteId}:${band}`,
        targetLabel: `${ctx.siteName} ${band}GHz`,
        observed: {
          band,
          radioCount: inBand.length,
          widths: widths.join(","),
          distinctWidths: widths.length,
        },
        messageCode: code("RF-03", c),
        messageParams: { band, widths: widths.join(", ") },
      }),
    );
  }

  if (out.length === 0) {
    out.push(
      mk(ctx, {
        ruleId: "RF-03",
        status: "unknown",
        targetType: "site",
        targetId: ctx.siteId,
        targetLabel: ctx.siteName,
        observed: { radioCount: 0 },
        messageCode: code("RF-03", "notCollected"),
      }),
    );
  }
  return out;
}

function rf14(ctx: Ctx, models: string[]): Finding {
  const present = models.filter(Boolean);
  const series = [...new Set(present.map(apSeries).filter((s): s is string => s !== null))].sort();

  let status: FindingStatus;
  let c: string;
  if (present.length === 0) {
    status = "unknown";
    c = "notCollected";
  } else if (series.length > 1) {
    status = "warn";
    c = "mixed";
  } else {
    status = "pass";
    c = "ok";
  }

  return mk(ctx, {
    ruleId: "RF-14",
    status,
    targetType: "site",
    targetId: ctx.siteId,
    targetLabel: ctx.siteName,
    observed: {
      apCount: present.length,
      models: [...new Set(present)].sort().join(","),
      series: series.join(","),
    },
    messageCode: code("RF-14", c),
    messageParams: { models: [...new Set(present)].sort().join(", "), series: series.join(", ") },
  });
}

// ── Central 全体 ────────────────────────────────────────────

/**
 * 代表 AP から取れた設定でサイトを判定する。
 * サイト内の他の AP と設定が食い違っている可能性は診断できない(49 §4-2)。
 */
export function evaluateCentral(
  snap: CentralSiteSnapshot,
  collectedAt: string,
  disabledRuleIds: string[] = [],
): Finding[] {
  const ctx: Ctx = {
    platform: "central",
    siteId: snap.siteId,
    siteName: snap.siteName,
    collectedAt,
    disabled: new Set(disabledRuleIds),
  };
  const out: Finding[] = [];

  // サイトに実在する帯域(ap_details の radios[])。
  // `show radio config` は 6GHz 無線を持たない機種でも 6.0 GHz セクションを出すため、
  // これで絞らないと存在しない無線に対する所見が出る。
  const presentBands = new Set<Band>(snap.radios.map((r) => r.band));
  const bandPresenceKnown = snap.radios.length > 0;

  for (const rep of snap.representatives) {
    const serial = rep.ap.serial;
    const apName = rep.ap.name || serial;

    // ---- SSID 単位 ----
    for (const ssid of rep.ssids) {
      out.push(sec01Central(ctx, serial, ssid));
      out.push(sec02Central(ctx, serial, ssid));
      out.push(sec03Central(ctx, serial, ssid));
      out.push({
        ...evaluateSec04(ssid, { platform: "central", targetId: serial, siteId: snap.siteId, collectedAt }),
      });
      out.push({
        ...evaluateSec05(ssid, { platform: "central", targetId: serial, siteId: snap.siteId, collectedAt }),
      });
      out.push(sec06Central(ctx, serial, ssid));
      out.push(rf08(ctx, serial, ssid));
      out.push(rfFlag(ctx, "RF-09", serial, ssid, ssid.dot11k));
      out.push(rfFlag(ctx, "RF-10", serial, ssid, ssid.okc));
      out.push(rf11(ctx, serial, ssid));
      out.push(rf12Ssid(ctx, serial, ssid));
    }

    // ---- WIDS / WIPS ----
    // `show ids-detection config` が取れないときは running-config の ids セクションに落とす
    // (AOS8 は running-config にも検知レベルが出る)。
    const infraLevel = rep.idsDetection?.infrastructureLevel ?? rep.ids?.infrastructureDetectionLevel ?? null;
    const clientLevel = rep.idsDetection?.clientLevel ?? rep.ids?.clientDetectionLevel ?? null;
    const levelSource = rep.idsDetection ? "show ids-detection config" : rep.ids ? "show running-config" : "";
    out.push(detectionLevelFinding(ctx, "SEC-07", serial, apName, infraLevel, levelSource));
    out.push(detectionLevelFinding(ctx, "SEC-08", serial, apName, clientLevel, levelSource));
    out.push(sec09(ctx, serial, apName, infraLevel, clientLevel));

    const wireless = rep.idsProtection?.wirelessContainment ?? rep.ids?.wirelessContainment ?? null;
    const protSource = rep.idsProtection ? "show ids-protection config" : rep.ids ? "show running-config" : "";
    out.push(sec10(ctx, serial, apName, wireless, rep.idsProtection?.wiredContainment ?? null, protSource));
    out.push(sec11(ctx, serial, apName, rep.idsProtection?.enabledPolicies ?? null));

    // ---- 無線単位 ----
    for (const radio of rep.radioProfiles) {
      // 実在しない帯域(AP-325 の 6GHz 等)は診ない
      if (bandPresenceKnown && !presentBands.has(radio.band)) continue;

      if (radio.band === "2.4") {
        out.push(rf01(ctx, serial, radio));
        // AOS8 の `show radio config` には Allowed channels が無い。ARM 側に落とす
        const allowed = radio.allowedChannels ?? (rep.arm ? rep.arm.channels24 : null);
        out.push(
          rf04(ctx, serial, radioTarget(serial, radio), allowed, radio.allowedChannels ? "show radio config" : "show arm config"),
        );
      }
      if (radio.band === "5") out.push(rf02(ctx, serial, radio));
      out.push(rf05(ctx, serial, radio));
      out.push(rf12Radio(ctx, serial, radio));
    }

    // ---- 帯域間の Tx 電力(RF-06 / RF-07)----
    const pick = (section: string) => rep.radioProfiles.find((r) => r.section === section) ?? null;
    const r24 = pick("2.4");
    const r5 = pick("5");
    const r6 = pick("6");
    const has = (b: Band) => !bandPresenceKnown || presentBands.has(b);

    out.push(
      rfCrossBand(ctx, "RF-06", serial, apName, r24?.minTxPower ?? null, r5?.minTxPower ?? null, {
        lower: "2.4",
        upper: "5",
      }),
    );
    if (has("6")) {
      out.push(
        rfCrossBand(ctx, "RF-07", serial, apName, r5?.minTxPower ?? null, r6?.minTxPower ?? null, {
          lower: "5",
          upper: "6",
        }),
      );
    } else {
      out.push(
        mk(ctx, {
          ruleId: "RF-07",
          status: "not_applicable",
          targetType: "ap",
          targetId: serial,
          targetLabel: apName,
          observed: { has6ghzRadio: false },
          messageCode: code("RF-07", "no6ghz"),
        }),
      );
    }

    // ---- ARM(AOS8 のみ)----
    if (rep.ap.generation === "aos10") {
      out.push(
        mk(ctx, {
          ruleId: "RF-13",
          status: "not_applicable",
          targetType: "ap",
          targetId: serial,
          targetLabel: apName,
          observed: { generation: rep.ap.generation },
          messageCode: code("RF-13", "aos10"),
          messageParams: { ap: apName },
        }),
      );
    } else if (!rep.arm) {
      out.push(
        mk(ctx, {
          ruleId: "RF-13",
          status: "unknown",
          targetType: "ap",
          targetId: serial,
          targetLabel: apName,
          observed: { generation: rep.ap.generation },
          messageCode: code("RF-13", "notCollected"),
          messageParams: { ap: apName },
        }),
      );
    } else {
      const off: string[] = [];
      if (rep.arm.scanning === false) off.push("scanning");
      if (rep.arm.clientMatch === false) off.push("client-match");
      out.push(
        mk(ctx, {
          ruleId: "RF-13",
          status: off.length ? "warn" : "pass",
          targetType: "ap",
          targetId: serial,
          targetLabel: apName,
          observed: {
            scanning: rep.arm.scanning,
            clientMatch: rep.arm.clientMatch,
            clientAware: rep.arm.clientAware,
            generation: rep.ap.generation,
          },
          messageCode: code("RF-13", off.length ? "disabled" : "ok"),
          messageParams: { ap: apName, features: off.join(", ") },
        }),
      );
    }
  }

  // ---- サイト単位 ----
  out.push(...rf03Central(ctx, snap.radios));
  out.push(rf14(ctx, snap.aps.map((a) => a.model)));

  return out.filter((f) => !ctx.disabled.has(f.ruleId));
}

// ── Mist ────────────────────────────────────────────────────

/**
 * Mist の pairwise / auth.type から暗号方式を分類する。
 *
 * `auth.pairwise` が**そもそも無い** WLAN が実在する(サイトスコープの WLAN に多い)。
 * これは「Mist の既定に委ねられている」という意味で、既定値を勝手に埋めると
 * 実際とずれた判定を出しうるので `pairwiseUnset` として区別し、`unknown` に落とす。
 */
function classifyMistWlan(w: MistSiteSnapshot["wlans"][number]): {
  family: "wpa3" | "wpa2" | "owe" | "open" | "legacy" | "pairwiseUnset" | "unknown";
} {
  const pw = (w.pairwise ?? []).map((p) => p.toLowerCase());
  const type = (w.authType ?? "").toLowerCase();

  if (type === "wep" || pw.some((p) => p.includes("tkip") || p.includes("wep"))) {
    return { family: "legacy" };
  }
  if (type === "open") return { family: "open" };
  if (type === "owe" || type === "open-owe") return { family: "owe" };
  if (w.pairwise === null || pw.length === 0) {
    // pairwise が無い = Mist 側の既定に委ねられている。既定値を断定しない
    return { family: "pairwiseUnset" };
  }
  if (pw.includes("wpa3")) return { family: "wpa3" };
  if (pw.some((p) => p.startsWith("wpa2"))) return { family: "wpa2" };
  return { family: "unknown" };
}

function mistUnknown(
  ctx: Ctx,
  ruleId: string,
  reason: string,
  target?: { targetType: Finding["targetType"]; targetId: string; targetLabel: string },
): Finding {
  return mk(ctx, {
    ruleId,
    status: "unknown",
    targetType: target?.targetType ?? "site",
    targetId: target?.targetId ?? ctx.siteId,
    targetLabel: target?.targetLabel ?? ctx.siteName,
    observed: { reason },
    messageCode: code(ruleId, reason),
  });
}

export function evaluateMist(
  snap: MistSiteSnapshot,
  collectedAt: string,
  disabledRuleIds: string[] = [],
): Finding[] {
  const ctx: Ctx = {
    platform: "mist",
    siteId: snap.siteId,
    siteName: snap.siteName,
    collectedAt,
    disabled: new Set(disabledRuleIds),
  };
  const out: Finding[] = [];

  // ---- WLAN 単位 ----
  for (const w of snap.wlans) {
    const target = { targetType: "ssid" as const, targetId: w.id, targetLabel: w.ssid };
    const { family } = classifyMistWlan(w);
    const observed: Record<string, ObservedValue> = {
      authType: w.authType,
      pairwise: w.pairwise ? w.pairwise.join(",") : null,
      bands: w.bands.join(","),
      enabled: w.enabled,
      scope: w.scope,
    };

    // SEC-01
    out.push(
      mk(ctx, {
        ruleId: "SEC-01",
        status:
          family === "legacy" || family === "open"
            ? "fail"
            : family === "pairwiseUnset" || family === "unknown"
              ? "unknown"
              : "pass",
        ...target,
        observed,
        messageCode: code(
          "SEC-01",
          family === "legacy"
            ? "tkip"
            : family === "open"
              ? "open"
              : family === "pairwiseUnset"
                ? "pairwiseUnset"
                : family === "unknown"
                  ? "opmodeUnknown"
                  : "ok",
        ),
        messageParams: { ssid: w.ssid, opmode: (w.pairwise ?? [w.authType ?? ""]).join("/") },
      }),
    );

    // SEC-02
    out.push(
      mk(ctx, {
        ruleId: "SEC-02",
        status:
          family === "owe"
            ? "pass"
            : family === "open"
              ? "warn"
              : family === "pairwiseUnset"
                ? // 暗号方式が不明でも「open ではない」ことは auth.type から分かる
                  "not_applicable"
                : family === "unknown"
                  ? "unknown"
                  : "not_applicable",
        ...target,
        observed,
        messageCode: code(
          "SEC-02",
          family === "owe" ? "owe" : family === "open" ? "openNotOwe" : family === "unknown" ? "opmodeUnknown" : "notOpen",
        ),
        messageParams: { ssid: w.ssid },
      }),
    );

    // SEC-03
    out.push(
      mk(ctx, {
        ruleId: "SEC-03",
        status:
          family === "wpa3" || family === "owe"
            ? "pass"
            : family === "wpa2"
              ? "warn"
              : family === "legacy" || family === "open"
                ? "not_applicable"
                : "unknown",
        ...target,
        observed,
        messageCode: code(
          "SEC-03",
          family === "wpa3"
            ? "wpa3"
            : family === "owe"
              ? "owe"
              : family === "wpa2"
                ? "wpa2"
                : family === "pairwiseUnset"
                  ? "pairwiseUnset"
                  : family === "unknown"
                    ? "opmodeUnknown"
                    : "legacy",
        ),
        messageParams: { ssid: w.ssid },
      }),
    );

    // SEC-04 / SEC-05: Mist の WLAN オブジェクトに PMF / transition mode の
    // 独立フィールドが無いため判定できない(49 §3-5)。not_applicable ではなく unknown。
    out.push(mistUnknown(ctx, "SEC-04", "noPmfField", target));
    out.push(mistUnknown(ctx, "SEC-05", "noTransitionField", target));

    // SEC-06
    const uses6 = w.bands.includes("6");
    const ok6 = family === "wpa3" || family === "owe";
    out.push(
      mk(ctx, {
        ruleId: "SEC-06",
        status:
          !uses6
            ? "not_applicable"
            : family === "pairwiseUnset" || family === "unknown"
              ? "unknown"
              : ok6
                ? "pass"
                : "fail",
        ...target,
        observed,
        messageCode: code(
          "SEC-06",
          !uses6
            ? "no6ghz"
            : family === "pairwiseUnset"
              ? "pairwiseUnset"
              : family === "unknown"
                ? "opmodeUnknown"
                : ok6
                  ? "ok"
                  : "notWpa3",
        ),
        messageParams: { ssid: w.ssid },
      }),
    );

    // RF-08〜RF-12: 該当フィールドを get_mist_config から確認できていない(49 §3-5)
    for (const id of ["RF-08", "RF-09", "RF-10", "RF-11", "RF-12"]) {
      out.push(mistUnknown(ctx, id, "notInMistConfig", target));
    }
  }

  // ---- WIDS / rogue(SEC-07〜SEC-11)----
  // site settings 配下の rogue オブジェクトに get_mist_config の resource_type から
  // 到達できない(49 §2-5)。到達手段が見つかるまで unknown を返す。
  for (const id of ["SEC-07", "SEC-08", "SEC-09", "SEC-10", "SEC-11"]) {
    out.push(mistUnknown(ctx, id, "rogueSettingsUnreachable"));
  }

  // ---- RF テンプレート ----
  const tpl = snap.rfTemplate;
  if (!tpl) {
    for (const id of ["RF-01", "RF-02", "RF-03", "RF-04", "RF-05", "RF-06", "RF-07"]) {
      out.push(mistUnknown(ctx, id, "noRfTemplate"));
    }
  } else {
    const band = (b: Band) => tpl.bands.find((x) => x.band === b) ?? null;
    const tplTarget = (b: Band) => ({
      targetType: "radio" as const,
      targetId: `${tpl.id}:${b}`,
      targetLabel: `${tpl.name} ${b}GHz`,
    });

    // RF-01(2.4GHz のチャネル幅)
    const b24 = band("2.4");
    out.push(
      mk(ctx, {
        ruleId: "RF-01",
        status: b24?.bandwidthMhz == null ? "unknown" : b24.bandwidthMhz > 20 ? "fail" : "pass",
        ...tplTarget("2.4"),
        observed: { band: "2.4", maxChannelBandwidthMhz: b24?.bandwidthMhz ?? null, template: tpl.name },
        messageCode: code("RF-01", b24?.bandwidthMhz == null ? "notCollected" : b24.bandwidthMhz > 20 ? "over20" : "ok"),
        messageParams: { radio: "2.4", bandwidth: b24?.bandwidthMhz ?? "" },
      }),
    );

    // RF-02(5GHz のチャネル幅)
    const b5 = band("5");
    out.push(
      mk(ctx, {
        ruleId: "RF-02",
        status: b5?.bandwidthMhz == null ? "unknown" : b5.bandwidthMhz > 80 ? "warn" : "pass",
        ...tplTarget("5"),
        observed: { band: "5", maxChannelBandwidthMhz: b5?.bandwidthMhz ?? null, template: tpl.name },
        messageCode: code("RF-02", b5?.bandwidthMhz == null ? "notCollected" : b5.bandwidthMhz > 80 ? "over80" : "ok"),
        messageParams: { radio: "5", bandwidth: b5?.bandwidthMhz ?? "" },
      }),
    );

    // RF-03: Mist は RF テンプレートが帯域ごとに単一のチャネル幅を配るので、
    // テンプレートが当たっている限り ESS 内で一致する。model_specific の上書きがある場合だけ warn。
    out.push(
      mk(ctx, {
        ruleId: "RF-03",
        status: tpl.hasModelSpecific ? "warn" : "pass",
        targetType: "site",
        targetId: `${ctx.siteId}:template`,
        targetLabel: `${ctx.siteName} / ${tpl.name}`,
        observed: {
          template: tpl.name,
          hasModelSpecific: tpl.hasModelSpecific,
          bandwidth24: b24?.bandwidthMhz ?? null,
          bandwidth5: b5?.bandwidthMhz ?? null,
          bandwidth6: band("6")?.bandwidthMhz ?? null,
        },
        messageCode: code("RF-03", tpl.hasModelSpecific ? "modelSpecific" : "uniformByTemplate"),
        messageParams: { template: tpl.name },
      }),
    );

    // RF-04(2.4GHz の許可チャネル)。channels: null = 自動(RRM 任せ)
    if (b24 && b24.channels === null) {
      out.push(
        mk(ctx, {
          ruleId: "RF-04",
          status: "pass",
          ...tplTarget("2.4"),
          observed: { allowedChannels: null, auto: true, template: tpl.name },
          messageCode: code("RF-04", "auto"),
        }),
      );
    } else {
      out.push(rf04(ctx, tpl.id, tplTarget("2.4"), b24?.channels ?? null, "rftemplates"));
    }

    // RF-05(同一無線の Tx 電力レンジ)
    for (const b of ["2.4", "5", "6"] as Band[]) {
      const bc = band(b);
      const min = bc?.powerMin ?? null;
      const max = bc?.powerMax ?? null;
      const diff = min !== null && max !== null ? max - min : null;
      out.push(
        mk(ctx, {
          ruleId: "RF-05",
          status: diff === null ? "unknown" : diff > 6 ? "warn" : "pass",
          ...tplTarget(b),
          observed: { band: b, minTxPower: min, maxTxPower: max, diff, template: tpl.name },
          messageCode: code("RF-05", diff === null ? "notCollected" : diff > 6 ? "wideRange" : "ok"),
          messageParams: { radio: b, diff: diff ?? "" },
        }),
      );
    }

    // RF-06 / RF-07(帯域間)
    out.push(
      rfCrossBand(ctx, "RF-06", tpl.id, tpl.name, band("2.4")?.powerMin ?? null, band("5")?.powerMin ?? null, {
        lower: "2.4",
        upper: "5",
      }),
    );
    out.push(
      rfCrossBand(ctx, "RF-07", tpl.id, tpl.name, band("5")?.powerMin ?? null, band("6")?.powerMin ?? null, {
        lower: "5",
        upper: "6",
      }),
    );
  }

  // RF-13(ARM)は Aruba 固有
  out.push(
    mk(ctx, {
      ruleId: "RF-13",
      status: "not_applicable",
      targetType: "site",
      targetId: ctx.siteId,
      targetLabel: ctx.siteName,
      observed: { reason: "centralOnly" },
      messageCode: code("RF-13", "centralOnly"),
    }),
  );

  // RF-14(AP モデル混在)
  out.push(rf14(ctx, snap.aps.map((a) => a.model)));

  return out.filter((f) => !ctx.disabled.has(f.ruleId));
}

// ── 集計 ────────────────────────────────────────────────────

export function summarize(findings: Finding[]) {
  const s = { pass: 0, warn: 0, fail: 0, not_applicable: 0, unknown: 0, info: 0, legalReview: 0 };
  for (const f of findings) {
    s[f.status] += 1;
    // 法務確認は「有効になっていた」ときだけ数える(pass では数えない)
    if (f.requiresLegalReview && (f.status === "warn" || f.status === "fail")) s.legalReview += 1;
  }
  return s;
}
