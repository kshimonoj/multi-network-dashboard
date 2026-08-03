/**
 * PMF(802.11w / Protected Management Frames)の判定。
 *
 * 確定した根拠は instructions/50_findings.md を参照。要点:
 *
 *  - `mfp-capable` / `mfp-required` は `wlan ssid-profile` の **独立したサブコマンド**であり、
 *    `opmode` の引数ではない(公式 CLI リファレンス + 公式設定例で確認)。
 *    パーサは念のため「opmode 行の後続トークン」形式にも対応している(running-config.ts)。
 *  - WPA3 / Enhanced Open では PMF はユーザー設定不可で、opmode と帯域と
 *    transition mode から MFPR / MFPC が一意に決まる。
 *  - transition mode は `opmode-transition` / `opmode-transition-disable` で読める。
 *    どちらも running-config に無ければ **既定値(有効)**。
 *
 * 出典:
 *  - Protected management frames
 *    https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/features/pmf/
 *  - Security modes(WPA3-Personal / WPA3-Enterprise / Enhanced Open)
 *    https://arubanetworking.hpe.com/techdocs/aos/wifi-design-deploy/security/modes/
 *  - wlan ssid-profile(CLI-Bank / Instant)
 *    https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/instant/wlan-ssid-prof.htm
 */

import type { Band, Finding, FindingStatus, SsidProfileConfig } from "./types";

export type OpmodeFamily =
  | "wpa3-transitionable" // wpa3-sae-aes / wpa3-aes-ccm-128
  | "wpa3-always-pmf"     // wpa3-cnsa / wpa3-aes-gcm-256
  | "enhanced-open"       // OWE。OWE BSS は常に PMF 必須
  | "wpa2"                // wpa2-aes / wpa2-psk-aes / mpsk-aes — PMF は任意設定
  | "legacy"              // WEP / TKIP / opensystem — PMF なし
  | "unknown";

/** MFPR / MFPC の値。null は「判定できない」 */
export interface PmfResolution {
  band: Band;
  mfpr: 0 | 1 | null;
  mfpc: 0 | 1 | null;
  /** どう決まったか。UI で「読み取り値」か「既定値からの推定」かを示すのに使う */
  basis:
    | "auto-by-opmode"        // WPA3 / OWE。仕様上自動
    | "auto-by-transition"    // WPA3 かつ transition mode の状態で分岐
    | "explicit"              // mfp-capable / mfp-required の行を読んだ
    | "implicit-mbo"          // mbo-enable が mfp-capable を暗黙で有効化
    | "default-disabled"      // WPA2 で mfp-* 行が無い = 既定の 0/0
    | "not-applicable"        // その帯域でその opmode は成立しない
    | "unknown";
  /** transition mode を既定値から推定した場合 true(明示行を読めていない) */
  transitionAssumedDefault?: boolean;
}

export function classifyOpmode(opmode: string | null): OpmodeFamily {
  if (!opmode) return "unknown";
  const m = opmode.toLowerCase();

  // 混在 opmode("wpa-tkip,wpa2-aes" 等)は TKIP/WEP を含む時点で legacy 扱い
  if (m.includes("tkip") || m.includes("wep")) return "legacy";
  if (m === "opensystem") return "legacy";
  if (m === "enhanced-open") return "enhanced-open";
  if (m === "wpa3-sae-aes" || m === "wpa3-aes-ccm-128") return "wpa3-transitionable";
  if (m === "wpa3-cnsa" || m === "wpa3-aes-gcm-256") return "wpa3-always-pmf";
  if (m === "wpa2-aes" || m === "wpa2-psk-aes" || m === "mpsk-aes") return "wpa2";
  return "unknown";
}

/** transition mode の実効値。明示行が無ければ既定(有効) */
export function effectiveTransition(ssid: SsidProfileConfig): {
  enabled: boolean;
  assumedDefault: boolean;
} {
  if (ssid.opmodeTransition === null) return { enabled: true, assumedDefault: true };
  return { enabled: ssid.opmodeTransition, assumedDefault: false };
}

/**
 * 1 つの SSID・1 つの帯域について MFPR / MFPC を決める(decoder ring)。
 */
export function resolvePmf(ssid: SsidProfileConfig, band: Band): PmfResolution {
  const family = classifyOpmode(ssid.opmode);

  switch (family) {
    case "enhanced-open":
      // OWE BSS は transition mode でも常に PMF 必須
      return { band, mfpr: 1, mfpc: 1, basis: "auto-by-opmode" };

    case "wpa3-always-pmf":
      return { band, mfpr: 1, mfpc: 1, basis: "auto-by-opmode" };

    case "wpa3-transitionable": {
      // 6GHz では transition mode は成立せず、常に PMF 必須
      if (band === "6") return { band, mfpr: 1, mfpc: 1, basis: "auto-by-opmode" };
      const { enabled, assumedDefault } = effectiveTransition(ssid);
      return enabled
        ? {
            band,
            mfpr: 0,
            mfpc: 1,
            basis: "auto-by-transition",
            transitionAssumedDefault: assumedDefault,
          }
        : {
            band,
            mfpr: 1,
            mfpc: 1,
            basis: "auto-by-transition",
            transitionAssumedDefault: assumedDefault,
          };
    }

    case "wpa2": {
      // 6GHz は WPA3 / Enhanced Open のみ。WPA2 は規格上成立しない(SEC-06 側で fail)
      if (band === "6") return { band, mfpr: null, mfpc: null, basis: "not-applicable" };
      if (ssid.mfpRequired) return { band, mfpr: 1, mfpc: 1, basis: "explicit" };
      if (ssid.mfpCapable) return { band, mfpr: 0, mfpc: 1, basis: "explicit" };
      // mbo-enable は mfp-capable を暗黙で有効化する(CLI リファレンス記載)
      if (ssid.mboEnable) return { band, mfpr: 0, mfpc: 1, basis: "implicit-mbo" };
      return { band, mfpr: 0, mfpc: 0, basis: "default-disabled" };
    }

    case "legacy":
      if (band === "6") return { band, mfpr: null, mfpc: null, basis: "not-applicable" };
      return { band, mfpr: 0, mfpc: 0, basis: "default-disabled" };

    default:
      return { band, mfpr: null, mfpc: null, basis: "unknown" };
  }
}

/** SSID 全帯域ぶんの解決結果 */
export function resolvePmfAllBands(ssid: SsidProfileConfig): PmfResolution[] {
  return ssid.bands.map((b) => resolvePmf(ssid, b));
}

// ── ルール評価 ────────────────────────────────────────────────

interface EvalContext {
  platform: "central" | "mist";
  targetId: string;
  siteId?: string;
  collectedAt: string;
}

/**
 * SEC-04: WPA2 系 SSID の PMF 未設定。
 *  - mfp-required あり            → pass(MFPR=1 / MFPC=1)
 *  - mfp-capable のみ             → warn(MFPR=0 / MFPC=1)
 *  - mbo-enable による暗黙 capable → warn
 *  - どちらも無い                 → fail(MFPR=0 / MFPC=0)
 *  - WPA2 系以外                  → not_applicable(PMF は自動で決まる)
 */
export function evaluateSec04(ssid: SsidProfileConfig, ctx: EvalContext): Finding {
  const family = classifyOpmode(ssid.opmode);

  let status: FindingStatus;
  let messageCode: string;

  if (family === "unknown") {
    status = "unknown";
    messageCode = "bestPractice.findings.SEC-04.opmodeUnknown";
  } else if (family !== "wpa2") {
    status = "not_applicable";
    messageCode = "bestPractice.findings.SEC-04.notWpa2";
  } else if (ssid.mfpRequired) {
    status = "pass";
    messageCode = "bestPractice.findings.SEC-04.required";
  } else if (ssid.mfpCapable) {
    status = "warn";
    messageCode = "bestPractice.findings.SEC-04.capableOnly";
  } else if (ssid.mboEnable) {
    status = "warn";
    messageCode = "bestPractice.findings.SEC-04.capableViaMbo";
  } else {
    status = "fail";
    messageCode = "bestPractice.findings.SEC-04.disabled";
  }

  // 2.4/5GHz を代表として観測値に載せる(WPA2 は 6GHz で成立しないため)
  const rep = resolvePmf(ssid, ssid.bands.includes("2.4") ? "2.4" : "5");

  return {
    ruleId: "SEC-04",
    status,
    platform: ctx.platform,
    targetType: "ssid",
    targetId: `${ctx.targetId}:${ssid.name}`,
    targetLabel: ssid.essid ?? ssid.name,
    siteId: ctx.siteId,
    observed: {
      opmode: ssid.opmode,
      opmodeFamily: family,
      mfpCapable: ssid.mfpCapable,
      mfpRequired: ssid.mfpRequired,
      mboEnable: ssid.mboEnable,
      mfpr: rep.mfpr,
      mfpc: rep.mfpc,
      basis: rep.basis,
      bands: ssid.bands.join(","),
      enabled: ssid.enabled,
    },
    messageCode,
    messageParams: {
      ssid: ssid.essid ?? ssid.name,
      opmode: ssid.opmode ?? "",
    },
    collectedAt: ctx.collectedAt,
  };
}

/**
 * SEC-05: WPA3 transition mode の常用回避。
 * transition mode が有効だと 2.4/5GHz で MFPR=0 になり、WPA2 相当の AKM が残る。
 *
 * 49 番では「取得方法が未確定」として unknown 固定だったが、50 番で
 * `opmode-transition` / `opmode-transition-disable` を読めることが確定したため
 * 機械判定に格上げした。明示行が無い場合は既定値(有効)として warn を返し、
 * 既定値からの推定であることを observed.transitionAssumedDefault で示す。
 */
export function evaluateSec05(ssid: SsidProfileConfig, ctx: EvalContext): Finding {
  const family = classifyOpmode(ssid.opmode);

  // transition mode を持つのは wpa3-sae-aes / wpa3-aes-ccm-128 / enhanced-open
  const applicable = family === "wpa3-transitionable" || family === "enhanced-open";

  const { enabled, assumedDefault } = effectiveTransition(ssid);
  // 6GHz のみの SSID は transition mode が成立しないので対象外
  const onlySixGhz = ssid.bands.length > 0 && ssid.bands.every((b) => b === "6");

  let status: FindingStatus;
  let messageCode: string;

  if (family === "unknown") {
    status = "unknown";
    messageCode = "bestPractice.findings.SEC-05.opmodeUnknown";
  } else if (!applicable || onlySixGhz) {
    status = "not_applicable";
    messageCode = "bestPractice.findings.SEC-05.notApplicable";
  } else if (family === "enhanced-open") {
    // OWE BSS 自体は PMF 必須のままなので、transition でも PMF 上の劣化は無い
    status = enabled ? "warn" : "pass";
    messageCode = enabled
      ? "bestPractice.findings.SEC-05.oweTransition"
      : "bestPractice.findings.SEC-05.disabled";
  } else {
    status = enabled ? "warn" : "pass";
    messageCode = enabled
      ? "bestPractice.findings.SEC-05.enabled"
      : "bestPractice.findings.SEC-05.disabled";
  }

  return {
    ruleId: "SEC-05",
    status,
    platform: ctx.platform,
    targetType: "ssid",
    targetId: `${ctx.targetId}:${ssid.name}`,
    targetLabel: ssid.essid ?? ssid.name,
    siteId: ctx.siteId,
    observed: {
      opmode: ssid.opmode,
      opmodeFamily: family,
      transitionEnabled: applicable ? enabled : null,
      transitionAssumedDefault: applicable ? assumedDefault : null,
      bands: ssid.bands.join(","),
      enabled: ssid.enabled,
    },
    messageCode,
    messageParams: {
      ssid: ssid.essid ?? ssid.name,
      opmode: ssid.opmode ?? "",
    },
    collectedAt: ctx.collectedAt,
  };
}
