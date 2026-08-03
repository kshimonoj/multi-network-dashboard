/**
 * `show running-config` を正規化する。
 *
 * 機微情報の扱い(49 §1-5(a)): このモジュールは wpa-passphrase / wep-key / key /
 * hash-mgmt-user / virtual-controller-key 等の値を **一切返さない**。設定の有無だけを
 * 真偽値に落とす。呼び出し側は生テキストを保存せず、パース直後に破棄すること
 * (collect-central.ts がその順序を守っている)。
 */

import { TX_POWER_UNSET } from "./types.js";
import type {
  Band,
  IdsLevel,
  RadioSection,
  RunningConfigIds,
  RunningConfigRfProfile,
  SsidProfileConfig,
} from "./types.js";

/** `wlan ssid-profile <name>` の name。引用符付きにも対応する */
const SSID_PROFILE_RE = /^wlan\s+ssid-profile\s+(?:"([^"]*)"|(\S+))\s*$/;

/** 引用符を外す */
function unquote(v: string): string {
  const m = /^"(.*)"$/.exec(v);
  return m ? m[1] : v;
}

/**
 * 先頭が空白でない行を「新しいトップレベルブロックの開始」とみなす。
 * AOS のコントローラ形式で使われるブロック終端 `!` も区切りとして扱う。
 */
function isBlockBoundary(line: string): boolean {
  if (line.trim() === "!") return true;
  if (line.trim() === "") return false; // 空行はブロック内にも現れる
  return !/^\s/.test(line);
}

/**
 * 見出し行が headRe に一致するトップレベルブロックを切り出す共通処理。
 * ssid-profile / rf ... / ids のいずれもこの形をしている。
 */
function splitBlocks(
  runningConfig: string,
  headRe: RegExp,
): Array<{ head: string; lines: string[] }> {
  const lines = runningConfig.split(/\r?\n/);
  const blocks: Array<{ head: string; lines: string[] }> = [];

  let current: { head: string; lines: string[] } | null = null;
  for (const line of lines) {
    const isTopLevel = !/^\s/.test(line);
    // ブロック開始行自体もインデントが無いので、先に見出し判定をする
    if (isTopLevel && headRe.test(line.trim())) {
      if (current) blocks.push(current);
      current = { head: line.trim(), lines: [] };
      continue;
    }
    if (!current) continue;
    if (isBlockBoundary(line)) {
      blocks.push(current);
      current = null;
      continue;
    }
    const body = line.trim();
    if (body) current.lines.push(body);
  }
  if (current) blocks.push(current);

  return blocks;
}

/**
 * MFP の検出。**2 つの出力形式に両対応する**(50 番で確定)。
 *
 *  (A) 正規形 — 独立したサブコマンド行。実機・公式 CLI リファレンスで確認済み:
 *        opmode wpa2-aes
 *        mfp-capable
 *        mfp-required
 *
 *  (B) フォールバック — opmode 行の後続トークン。実機では観測されていないが、
 *      一部ドキュメントが 1 行に連結した形で記載しているため保険で受ける:
 *        opmode wpa2-aes mfp-capable mfp-required
 *
 * `no mfp-capable` / `no mfp-required` による打ち消しにも対応する。
 */
function detectMfpTokens(bodyLines: string[]): {
  mfpCapable: boolean;
  mfpRequired: boolean;
  opmode: string | null;
} {
  let mfpCapable = false;
  let mfpRequired = false;
  let opmode: string | null = null;

  for (const line of bodyLines) {
    const tokens = line.split(/\s+/);
    const negated = tokens[0] === "no";
    const head = negated ? tokens[1] : tokens[0];
    if (!head) continue;

    // (A) 独立行
    if (head === "mfp-capable") {
      mfpCapable = !negated;
      continue;
    }
    if (head === "mfp-required") {
      mfpRequired = !negated;
      continue;
    }

    if (head === "opmode") {
      const rest = tokens.slice(negated ? 2 : 1);
      if (negated) {
        opmode = null;
        continue;
      }
      // 先頭の 1 トークンだけが opmode 本体
      opmode = rest[0] ?? null;
      // (B) 同一行に mfp-* が続いていれば拾う
      for (const t of rest.slice(1)) {
        if (t === "mfp-capable") mfpCapable = true;
        if (t === "mfp-required") mfpRequired = true;
      }
    }
  }

  return { mfpCapable, mfpRequired, opmode };
}

/** `rf-band` / `rf-band-6ghz` から実際に電波を出す帯域を決める */
function detectBands(bodyLines: string[]): Band[] {
  // CLI リファレンス上 rf-band の既定は all
  let rfBand = "all";
  let sixGhz = false;

  for (const line of bodyLines) {
    const tokens = line.split(/\s+/);
    const negated = tokens[0] === "no";
    const head = negated ? tokens[1] : tokens[0];

    if (head === "rf-band-6ghz") {
      sixGhz = !negated;
      continue;
    }
    if (head === "rf-band") {
      rfBand = negated ? "none" : (tokens[negated ? 2 : 1] ?? "all");
    }
  }

  const bands: Band[] = [];
  const b = rfBand.toLowerCase();
  if (b === "all" || b === "2.4" || b === "2.4ghz") bands.push("2.4");
  if (b === "all" || b === "5.0" || b === "5" || b === "5ghz") bands.push("5");
  if (sixGhz) bands.push("6");
  return bands;
}

/** opmode transition mode。行が無ければ null(= 既定値。pmf.ts 側で「有効」と解釈する) */
function detectOpmodeTransition(bodyLines: string[]): boolean | null {
  let result: boolean | null = null;
  for (const line of bodyLines) {
    const tokens = line.split(/\s+/);
    const negated = tokens[0] === "no";
    const head = negated ? tokens[1] : tokens[0];

    if (head === "opmode-transition-disable") result = negated ? true : false;
    else if (head === "opmode-transition") result = negated ? false : true;
  }
  return result;
}

function hasFlag(bodyLines: string[], flag: string): boolean {
  let on = false;
  for (const line of bodyLines) {
    const tokens = line.split(/\s+/);
    const negated = tokens[0] === "no";
    const head = negated ? tokens[1] : tokens[0];
    if (head === flag) on = !negated;
  }
  return on;
}

/**
 * `<key> <value>` の値を返す。機微情報の取得には使わないこと。
 * 値が引用符で括られていれば空白を含めて 1 つの値として取り出す
 * (`essid "guest wifi"` のようなケース)。
 */
function firstValue(bodyLines: string[], key: string): string | null {
  for (const line of bodyLines) {
    if (!line.startsWith(`${key} `)) continue;
    const rest = line.slice(key.length + 1).trim();
    if (!rest) continue;
    const quoted = /^"([^"]*)"/.exec(rest);
    if (quoted) return quoted[1];
    return rest.split(/\s+/)[0];
  }
  return null;
}

/** 同じキーの行が複数あるものを全部集める(auth-server 等) */
function allValues(bodyLines: string[], key: string): string[] {
  const out: string[] = [];
  for (const line of bodyLines) {
    if (!line.startsWith(`${key} `)) continue;
    const rest = line.slice(key.length + 1).trim();
    if (!rest) continue;
    const quoted = /^"([^"]*)"/.exec(rest);
    const v = quoted ? quoted[1] : rest.split(/\s+/)[0];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** `a-basic-rates 12,24` → [12, 24]。行が無ければ null(= 既定に委ねられている) */
function rateList(bodyLines: string[], key: string): number[] | null {
  const raw = firstValue(bodyLines, key);
  if (raw === null) return null;
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number.parseFloat(part.trim());
    if (Number.isFinite(n)) out.push(n);
  }
  return out.length ? out : null;
}

/**
 * running-config 全文から SSID プロファイルを取り出す。
 * 返り値には鍵・パスフレーズを含めない。
 */
export function parseSsidProfiles(runningConfig: string): SsidProfileConfig[] {
  return splitBlocks(runningConfig, SSID_PROFILE_RE).map(({ head, lines }) => {
    const m = SSID_PROFILE_RE.exec(head);
    const name = unquote(m?.[1] ?? m?.[2] ?? "");
    const { mfpCapable, mfpRequired, opmode } = detectMfpTokens(lines);

    // `disable` があれば無効。既定は有効
    const disabled = hasFlag(lines, "disable");
    const enabled = hasFlag(lines, "enable") || !disabled;

    // broadcast-filter は値付き(arp / all / none)。`no broadcast-filter` は未設定に倒す
    const bcastNegated = lines.some((l) => /^no\s+broadcast-filter(\s|$)/.test(l));

    return {
      name,
      essid: firstValue(lines, "essid"),
      enabled: disabled ? false : enabled,
      ssidType: firstValue(lines, "type"),
      opmode,
      mfpCapable,
      mfpRequired,
      mboEnable: hasFlag(lines, "mbo-enable"),
      opmodeTransition: detectOpmodeTransition(lines),
      bands: detectBands(lines),
      dot11k: hasFlag(lines, "dot11k") || hasFlag(lines, "mbo-enable"),
      dot11v: hasFlag(lines, "dot11v"),
      okc: hasFlag(lines, "okc"),
      broadcastFilter: bcastNegated ? null : firstValue(lines, "broadcast-filter"),
      broadcastFilterIpv6Ra:
        firstValue(lines, "broadcast-filter-ipv6") === "unicast-router-advertisements",
      aBasicRates: rateList(lines, "a-basic-rates"),
      gBasicRates: rateList(lines, "g-basic-rates"),
      ehtDisable: hasFlag(lines, "extremely-high-throughput-disable"),
      heDisable: hasFlag(lines, "high-efficiency-disable") || hasFlag(lines, "he-disable"),
      authServers: allValues(lines, "auth-server"),
      // 値は持たず、設定されているかだけを残す
      hasPassphrase: lines.some((l) => l.startsWith("wpa-passphrase ")),
      hasWepKey: lines.some((l) => l.startsWith("wep-key ")),
    };
  });
}

// ── `ids` セクション ────────────────────────────────────────

function toIdsLevel(v: string | null): IdsLevel | null {
  if (!v) return null;
  const s = v.toLowerCase();
  return s === "off" || s === "low" || s === "medium" || s === "high" ? s : null;
}

/**
 * running-config の `ids` セクション。
 *
 * AOS10 は `wireless-containment` しか出さないが、**AOS8 は検知レベルも
 * `infrastructure-detection-level` / `client-detection-level` として出力する**
 * (50 §5 の補足で入口だけ記録されていた点。実機で確認した)。
 * `show ids-detection config` が取れなかったときのフォールバックに使う。
 */
export function parseIdsSection(runningConfig: string): RunningConfigIds | null {
  const blocks = splitBlocks(runningConfig, /^ids$/);
  if (blocks.length === 0) return null;
  const lines = blocks[0].lines;
  return {
    wirelessContainment: firstValue(lines, "wireless-containment"),
    infrastructureDetectionLevel: toIdsLevel(firstValue(lines, "infrastructure-detection-level")),
    clientDetectionLevel: toIdsLevel(firstValue(lines, "client-detection-level")),
  };
}

// ── `rf dot11*-radio-profile` セクション ─────────────────────

const RF_PROFILE_HEADS: Array<{ head: string; section: RadioSection }> = [
  { head: "rf dot11g-radio-profile", section: "2.4" },
  { head: "rf dot11a-radio-profile", section: "5" },
  { head: "rf dot11a-secondary-radio-profile", section: "5-secondary" },
  { head: "rf dot11-6ghz-radio-profile", section: "6" },
  { head: "rf dot11-6ghz-secondary-radio-profile", section: "6-secondary" },
];

const RF_PROFILE_RE = /^rf\s+dot11[a-z0-9-]*radio-profile$/;

/** `ch-bw-range 20MHz 160MHz` → { min: 20, max: 160 } */
function parseChBwRange(lines: string[]): { min: number | null; max: number | null } {
  for (const line of lines) {
    const m = /^ch-bw-range\s+(\S+)\s+(\S+)/.exec(line);
    if (!m) continue;
    return { min: parseBandwidth(m[1]), max: parseBandwidth(m[2]) };
  }
  return { min: null, max: null };
}

/** "160MHz" / "160" → 160 */
export function parseBandwidth(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /(\d+)\s*MHz/i.exec(v) ?? /^(\d+)$/.exec(v.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function toInt(v: string | null): number | null {
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** `max-tx-power 127` は「未設定(ARM 任せ)」の番兵。AOS8 の実機で観測 */
function toTxPower(v: string | null): number | null {
  const n = toInt(v);
  return n === TX_POWER_UNSET ? null : n;
}

/**
 * `rf dot11*-radio-profile` を取り出す。
 * `show radio config` が取れなかった世代(または将来のコマンド変更)への保険。
 * **2.4GHz は既定 20MHz のとき ch-bw-range 行そのものが出ない**(49 §1-2 の 8')。
 */
export function parseRfProfiles(runningConfig: string): RunningConfigRfProfile[] {
  const out: RunningConfigRfProfile[] = [];
  for (const { head, lines } of splitBlocks(runningConfig, RF_PROFILE_RE)) {
    const known = RF_PROFILE_HEADS.find((h) => h.head === head);
    if (!known) continue;
    const bw = parseChBwRange(lines);
    out.push({
      section: known.section,
      maxTxPower: toTxPower(firstValue(lines, "max-tx-power")),
      minTxPower: toTxPower(firstValue(lines, "min-tx-power")),
      chBwRangeMin: bw.min,
      chBwRangeMax: bw.max,
    });
  }
  return out;
}
