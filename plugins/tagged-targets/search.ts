/**
 * タグ付き対象(59)— 対象を探してタグを付けるための検索。
 *
 * 57 §3-3 の「付与の入口」のうち、本タブの一覧から入る経路。
 * Central / Mist の**両方に投げて結果を統合**する。片方が落ちても他方は返す。
 *
 * ランダム MAC の判定(57 §3-5 / 58 §1-8-4)はここで確定させ、
 * 付与ダイアログがその場で警告を出せるようにする。判定材料の優先順位:
 *   1. Mist の `random_mac`(真偽値。最も確実)
 *   2. Central の `clientManufacturer === "Private"`
 *   3. MAC のローカル管理ビット(材料が無いときの最後の手段)
 */

import {
  fetchAllCentralClients,
  fetchAllCentralDevices,
  isCentralConfigured,
} from "./central-fetch.js";
import { fetchMistClientIndex, fetchMistDeviceIndex, isMistConfigured } from "./mist-fetch.js";
import { looksLocallyAdministered, normalizeMac } from "./mac.js";
import type { SearchHit, TargetKind } from "./types.js";

function matches(q: string, ...fields: Array<string | null>): boolean {
  const needle = q.toLowerCase();
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
}

/**
 * @param kind    client / device
 * @param query   MAC(区切りの有無を問わない)・ホスト名・デバイス名・シリアルの部分一致
 */
export async function searchTargets(
  kind: TargetKind,
  query: string,
  limit = 40,
): Promise<{ hits: SearchHit[]; errors: Array<{ platform: string; error: string }> }> {
  const q = query.trim();
  if (!q) return { hits: [], errors: [] };
  // "aa:bb:cc" のような部分 MAC でも当たるよう、16 進だけの表記も併せて見る。
  const qHex = q.toLowerCase().replace(/[^0-9a-f]/g, "");
  const hits: SearchHit[] = [];
  const errors: Array<{ platform: string; error: string }> = [];

  const tasks: Array<Promise<void>> = [];

  if (isCentralConfigured()) {
    tasks.push(
      (async () => {
        try {
          if (kind === "client") {
            for (const c of await fetchAllCentralClients()) {
              const macHit = qHex.length >= 2 && c.mac.includes(qHex);
              if (!macHit && !matches(q, c.clientName, c.hostName, c.ipv4, c.siteName)) continue;
              hits.push({
                kind: "client",
                platform: "central",
                key: c.mac,
                serial: null,
                label: c.clientName ?? c.hostName,
                sub: [c.connectionType, c.wlanName, c.ipv4].filter(Boolean).join(" · ") || null,
                siteId: c.siteId,
                siteName: c.siteName,
                randomMac: c.clientManufacturer === "Private" ? true : null,
                randomMacSource: c.clientManufacturer === "Private" ? "central" : null,
              });
            }
          } else {
            for (const d of await fetchAllCentralDevices()) {
              const macHit = qHex.length >= 2 && (d.macAddress ?? "").includes(qHex);
              if (!macHit && !matches(q, d.deviceName, d.serialNumber, d.model, d.siteName, d.ipv4)) continue;
              if (!d.macAddress) continue; // 正準キーが作れない対象は登録できない
              hits.push({
                kind: "device",
                platform: "central",
                key: d.macAddress,
                serial: d.serialNumber,
                label: d.deviceName ?? d.serialNumber,
                sub: [d.deviceType, d.model, d.status].filter(Boolean).join(" · ") || null,
                siteId: d.siteId,
                siteName: d.siteName,
                randomMac: false,
                randomMacSource: null,
              });
            }
          }
        } catch (err) {
          errors.push({ platform: "central", error: err instanceof Error ? err.message : String(err) });
        }
      })(),
    );
  }

  if (isMistConfigured()) {
    tasks.push(
      (async () => {
        try {
          if (kind === "client") {
            for (const c of await fetchMistClientIndex()) {
              const macHit = qHex.length >= 2 && c.mac.includes(qHex);
              if (!macHit && !matches(q, c.hostname, c.ip, c.siteName, c.username, c.pskName)) continue;
              hits.push({
                kind: "client",
                platform: "mist",
                key: c.mac,
                serial: null,
                label: c.hostname,
                sub: [c.connectionType, c.ssid, c.ip].filter(Boolean).join(" · ") || null,
                siteId: c.siteId,
                siteName: c.siteName,
                randomMac: c.randomMac,
                randomMacSource: c.randomMac === null ? null : "mist",
              });
            }
          } else {
            for (const d of await fetchMistDeviceIndex()) {
              const macHit = qHex.length >= 2 && d.mac.includes(qHex);
              if (!macHit && !matches(q, d.name, d.serial, d.model, d.siteName, d.ip)) continue;
              hits.push({
                kind: "device",
                platform: "mist",
                key: d.mac,
                serial: d.serial,
                label: d.name ?? d.mac,
                sub: [d.type, d.model, d.status].filter(Boolean).join(" · ") || null,
                siteId: d.siteId,
                siteName: d.siteName,
                randomMac: false,
                randomMacSource: null,
              });
            }
          }
        } catch (err) {
          errors.push({ platform: "mist", error: err instanceof Error ? err.message : String(err) });
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // 判定材料がどちらのプラットフォームからも得られなかったクライアントだけ、
  // MAC のローカル管理ビットで補う(確度が下がるので source を分けて持つ)。
  for (const h of hits) {
    if (h.kind === "client" && h.randomMac === null && looksLocallyAdministered(h.key)) {
      h.randomMac = true;
      h.randomMacSource = "mac-bit";
    }
  }

  hits.sort((a, b) => (a.label ?? a.key).localeCompare(b.label ?? b.key));
  return { hits: hits.slice(0, limit), errors };
}

/** 手入力の MAC をそのまま登録する経路(検索に出てこない対象のため)。 */
export function manualHit(kind: TargetKind, rawMac: string, serial: string | null): SearchHit | null {
  const key = normalizeMac(rawMac);
  if (!key) return null;
  const random = kind === "client" && looksLocallyAdministered(key);
  return {
    kind,
    platform: "central",
    key,
    serial,
    label: null,
    sub: null,
    siteId: null,
    siteName: null,
    randomMac: random ? true : null,
    randomMacSource: random ? "mac-bit" : null,
  };
}
