/**
 * タグ付き対象(59)— MAC アドレスの正規化。
 *
 * 57 §3-2 の確定事項:
 *   - **正準キーは区切り無し小文字 12 桁**。保存は常にこの形。
 *   - Central は `xx:xx:xx:xx:xx:xx`(コロン区切り)、Mist は区切り無しで返す。
 *     表示はコロン区切りに戻す(既存 UI の見やすさに合わせる)。
 *
 * 59 の実測で判明した追加制約:
 *   - Central の単体引き `GET network-monitoring/v1/clients/{mac}` は
 *     **コロン区切りでないと HTTP 400**。区切り無し 12 桁は受け付けない。
 *     → API に渡す直前に toColonMac() で戻すこと。
 *   - Mist の `stats/clients/{mac}` は区切り無し 12 桁。
 */

/** 任意表記の MAC → 区切り無し小文字 12 桁。MAC として読めなければ null。 */
export function normalizeMac(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex : null;
}

/** 正準キー(12 桁)→ 表示用のコロン区切り。Central API に渡す形でもある。 */
export function toColonMac(key: string): string {
  return (key.match(/.{2}/g) ?? []).join(":");
}

/**
 * ランダム MAC(ローカル管理アドレス)の疑いを MAC 自体から判定する。
 * 先頭オクテットの bit1(0x02)が立っていればローカル管理 = 端末が自分で生成した値。
 *
 * これは**補助判定**。正となるのは Mist の `random_mac` と
 * Central の `clientManufacturer === "Private"`(58 §1-8-4)で、
 * どちらも取れない対象(手入力で登録した直後など)のときだけこちらを使う。
 */
export function looksLocallyAdministered(key: string): boolean {
  if (key.length !== 12) return false;
  const firstOctet = Number.parseInt(key.slice(0, 2), 16);
  return Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0;
}

/** シリアル番号の正規化(前後空白を除いて大文字化)。空なら null。 */
export function normalizeSerial(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  return s ? s : null;
}
