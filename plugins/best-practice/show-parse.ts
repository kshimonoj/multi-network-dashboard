/**
 * `show radio config` / `show ids-detection config` / `show ids-protection config` /
 * `show arm config` の出力を正規化する。
 *
 * 出力形式は実機で確認したもの(AP-505H = AOS 10.8 / AP-325 = AOS 10.4 / AP-225 = AOS 8.6)。
 * 世代差で欠ける項目は **null** にして、判定側が `unknown` を返せるようにする
 * (「取れなかった」を「0 だった」と取り違えないため)。
 *
 * これらのコマンドの出力に鍵・パスフレーズは含まれないが、running-config と同じく
 * 生テキストは保存せず、この構造体だけを次段へ渡す。
 *
 * 異常入力(空文字 / `% Parse error.` / コマンドカタログ全文)を渡されても
 * 例外を投げず「空 or null」を返すこと。収集側の失敗がそのまま落ちてくるため。
 */

import type {
  ArmConfig,
  Band,
  IdsDetectionConfig,
  IdsLevel,
  IdsProtectionConfig,
  RadioProfileConfig,
  RadioSection,
} from "./types.js";
import { TX_POWER_UNSET } from "./types.js";
import { parseBandwidth } from "./running-config.js";

// ── 共通 ────────────────────────────────────────────────────

/** `Key : value` / `Key:value` の行から値を取り出す */
function kv(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!key) return null;
  return { key, value };
}

function toBool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (s === "enable" || s === "enabled" || s === "yes" || s === "on" || s === "true") return true;
  if (s === "disable" || s === "disabled" || s === "no" || s === "off" || s === "false") return false;
  return null;
}

function toInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function toIdsLevel(v: string | undefined): IdsLevel | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  return s === "off" || s === "low" || s === "medium" || s === "high" ? s : null;
}

/**
 * `Policies  Status  Low  Medium  High` 形式の表から、Status 列が enable の
 * ポリシー名だけを取り出す。列数はコマンド(検知 4 列 / 保護 3 列)で違うので、
 * 「1 列目 = 名前 / 2 列目 = Status」だけを見る。
 */
function enabledPolicies(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("---") || line.startsWith("Policies")) continue;
    const cols = line.split(/\s{2,}|\t+/).filter(Boolean);
    if (cols.length < 2) continue;
    const name = cols[0].trim();
    const status = cols[1].trim().toLowerCase();
    // ポリシー名は必ず detect- / signature- / protect- / rogue- で始まる
    if (!/^(detect|signature|protect|rogue)-/.test(name)) continue;
    if (status === "enable") out.push(name);
  }
  return out;
}

// ── `show radio config` ─────────────────────────────────────

const SECTION_HEADS: Array<{ re: RegExp; section: RadioSection; band: Band }> = [
  { re: /^Secondary\s+5(\.0)?\s*GHz:?$/i, section: "5-secondary", band: "5" },
  { re: /^Secondary\s+6(\.0)?\s*GHz:?$/i, section: "6-secondary", band: "6" },
  { re: /^2\.4\s*GHz:?$/i, section: "2.4", band: "2.4" },
  { re: /^5(\.0)?\s*GHz:?$/i, section: "5", band: "5" },
  { re: /^6(\.0)?\s*GHz:?$/i, section: "6", band: "6" },
];

function matchSectionHead(line: string): { section: RadioSection; band: Band } | null {
  const t = line.trim();
  for (const s of SECTION_HEADS) {
    if (s.re.test(t)) return { section: s.section, band: s.band };
  }
  return null;
}

/** `Max Tx Power:127` は「未設定(ARM 任せ)」の番兵。実機 AOS8 で観測 */
function txPower(v: string | undefined): number | null {
  const n = toInt(v);
  if (n === null) return null;
  return n === TX_POWER_UNSET ? null : n;
}

/**
 * `show radio config` を帯域セクションごとに正規化する。
 *
 * 注意: 6GHz 無線を持たない機種(AP-325 等)でも `6.0 GHz` セクションが出力される。
 * これは **無線プロファイルの一覧**であって物理無線の一覧ではないため、
 * 判定側は central_get_ap_details の radios[] と突き合わせて実在する帯域だけを診る
 * (evaluate.ts の `presentBands`)。
 *
 * AOS8 の出力には `Max channel bandwidth` / `Allowed channels` / `Scanning-disable` が
 * 無い。その場合は null のままにして、判定側で `unknown` に落とす。
 */
export function parseRadioConfig(text: string): RadioProfileConfig[] {
  const out: RadioProfileConfig[] = [];
  if (!text) return out;

  let current: { section: RadioSection; band: Band; fields: Map<string, string> } | null = null;
  const flush = () => {
    if (!current) return;
    const f = current.fields;
    const allowedRaw = f.get("Allowed channels");
    out.push({
      section: current.section,
      band: current.band,
      profileName: f.get("Profile Name") ?? null,
      maxTxPower: txPower(f.get("Max Tx Power")),
      minTxPower: txPower(f.get("Min Tx Power")),
      maxChannelBandwidthMhz: parseBandwidth(f.get("Max channel bandwidth")),
      minChannelBandwidthMhz: parseBandwidth(f.get("Min channel bandwidth")),
      allowedChannels:
        allowedRaw === undefined
          ? null
          : allowedRaw
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean),
      scanningDisabled: (() => {
        // `Scanning-disable:No` = スキャン有効。反転して持たない(名前どおりに保つ)
        const b = toBool(f.get("Scanning-disable"));
        return b;
      })(),
      aggressiveScan: toBool(f.get("Aggressive-scan")),
      backgroundSpectrumMonitor: toBool(f.get("Background Spectrum Monitor")),
      rogueApAware: toBool(f.get("Rogue AP Aware")),
      heMuOfdma: toBool(f.get("HE MU-OFDMA")),
      heMuMimo: toBool(f.get("HE MU-MIMO")),
      heTxBf: toBool(f.get("HE TxBF")),
      ehtMuOfdma: toBool(f.get("EHT MU-OFDMA")),
      ehtMuMimo: toBool(f.get("EHT MU-MIMO")),
      ehtTxBf: toBool(f.get("EHT TxBF")),
    });
    current = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line)) continue;
    const head = matchSectionHead(line);
    if (head) {
      flush();
      current = { ...head, fields: new Map() };
      continue;
    }
    if (!current) continue;
    const pair = kv(line);
    if (pair) current.fields.set(pair.key, pair.value);
  }
  flush();

  return out;
}

// ── `show ids-detection config` ─────────────────────────────

/**
 * 検知設定。infrastructure / client の 2 ブロックがあり、それぞれの直後に
 * ポリシー表が続く。ブロックの切れ目は `client detection level` 行。
 */
export function parseIdsDetectionConfig(text: string): IdsDetectionConfig | null {
  if (!text || !/detection level/i.test(text)) return null;

  const lines = text.split(/\r?\n/);
  let infrastructureLevel: IdsLevel | null = null;
  let clientLevel: IdsLevel | null = null;
  const infraLines: string[] = [];
  const clientLines: string[] = [];
  let target: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^infrastructure detection level/i.test(line)) {
      infrastructureLevel = toIdsLevel(kv(line)?.value);
      target = infraLines;
      continue;
    }
    if (/^client detection level/i.test(line)) {
      clientLevel = toIdsLevel(kv(line)?.value);
      target = clientLines;
      continue;
    }
    if (target) target.push(line);
  }

  return {
    infrastructureLevel,
    clientLevel,
    enabledInfrastructurePolicies: enabledPolicies(infraLines),
    enabledClientPolicies: enabledPolicies(clientLines),
  };
}

// ── `show ids-protection config` ────────────────────────────

/**
 * 保護(封じ込め)設定。
 * 末尾に `... Default` 付きの行が続くが、これは既定値の再掲なので取り込まない
 * (先に現れる実効値を優先する)。
 */
export function parseIdsProtectionConfig(text: string): IdsProtectionConfig | null {
  if (!text || !/Containment/i.test(text)) return null;

  const lines = text.split(/\r?\n/);
  const first = new Map<string, string>();
  const policyLines: string[] = [];
  let inPolicies = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Policies\b/.test(line)) {
      inPolicies = true;
      continue;
    }
    const pair = kv(line);
    if (pair) {
      // `Default` 付きの再掲行は無視する
      if (!/\bDefault\b/i.test(pair.key) && !first.has(pair.key)) first.set(pair.key, pair.value);
      if (/level$/i.test(pair.key)) inPolicies = false;
      continue;
    }
    if (inPolicies) policyLines.push(line);
  }

  return {
    wirelessContainment: first.get("Wireless Containment") ?? null,
    wiredContainment: first.get("Wired Containment") ?? null,
    wiredContainmentApAdjacentMac: first.get("Wired Containment AP Adjacent MAC") ?? null,
    wiredContainmentSuspectLayer3Rogue:
      first.get("Wired Containment Suspect Layer3 Rogue") ?? null,
    infrastructureLevel: toIdsLevel(first.get("infrastructure protection level")),
    clientLevel: toIdsLevel(first.get("client protection level")),
    enabledPolicies: enabledPolicies(policyLines),
  };
}

// ── `show arm config`(AOS 8 のみ)────────────────────────────

/**
 * ARM 設定。AOS 10 では `% Parse error.` になるため、そちらでは呼ばれない
 * (ホワイトリストが世代で分かれている。collect-central.ts)。
 * 末尾のチャネル表は `2.4 GHz Channels` / `5.0 GHz Channels` の 2 ブロック。
 */
export function parseArmConfig(text: string): ArmConfig | null {
  if (!text || /Parse error/i.test(text) || !/Client Match/i.test(text)) return null;

  const f = new Map<string, string>();
  const channels24: string[] = [];
  const channels5: string[] = [];
  let channelTarget: string[] | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line)) continue;

    if (/^2\.4\s*GHz\s+Channels/i.test(line)) {
      channelTarget = channels24;
      continue;
    }
    if (/^5(\.0)?\s*GHz\s+Channels/i.test(line)) {
      channelTarget = channels5;
      continue;
    }
    if (/^6(\.0)?\s*GHz\s+Channels/i.test(line)) {
      // AOS8 の機種に 6GHz は無いが、将来出ても壊れないよう読み飛ばす先を用意する
      channelTarget = [];
      continue;
    }

    if (channelTarget) {
      if (/^Channel\b/i.test(line)) continue;
      const cols = line.split(/\s+/).filter(Boolean);
      if (cols.length >= 2 && /^[0-9]+[+ES]?$/.test(cols[0])) {
        if (cols[1].toLowerCase() === "enable") channelTarget.push(cols[0]);
        continue;
      }
    }

    const pair = kv(line);
    if (pair) f.set(pair.key, pair.value);
  }

  return {
    scanning: toBool(f.get("Scanning")),
    clientMatch: toBool(f.get("Client Match")),
    clientAware: toBool(f.get("Client Aware")),
    aggressiveScan: toBool(f.get("Aggressive Scan")),
    bandSteeringMode: f.get("Band Steering Mode") ?? null,
    minTxPower: (() => {
      const n = toInt(f.get("Minimum Transmit Power"));
      return n === TX_POWER_UNSET ? null : n;
    })(),
    maxTxPower: (() => {
      const n = toInt(f.get("Maximum Transmit Power"));
      return n === TX_POWER_UNSET ? null : n;
    })(),
    wideChannelBands: f.get("Wide Channel Bands") ?? null,
    support80MHz: toBool(f.get("80Mhz Support")),
    support160MHz: (() => {
      const v = f.get("160Mhz Support");
      // `none` は「非対応」= false
      if (v !== undefined && v.trim().toLowerCase() === "none") return false;
      return toBool(v);
    })(),
    customChannels: toBool(f.get("Custom Channels")),
    channels24,
    channels5,
  };
}
