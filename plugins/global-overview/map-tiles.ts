// サイトマップの地図タイル設定(85)。
//
// 背景: CARTO が 2026 年 8 月下旬から、basemaps.cartocdn.com へのキーなしリクエストに
// 「API KEY REQUIRED」の透かし入りタイルを返すようになった。HTTP 200 のまま返るので
// 通信エラーとしては検知できない。無料キーは https://carto.com/basemaps/apikey/ で即時発行され、
// タイル URL に ?key=... を付けて渡す。
//
// このキーは「ブラウザのタイル URL に載る前提の値」であり、サーバのシークレットではない。
// ただしリポジトリにはハードコードせず、.env(git 管理外)→ 環境変数で受け取る。
//
// 環境変数(すべて任意。未設定なら従来どおり CARTO をキーなしで使う = 透かしは出るが動作はする):
//   CARTO_API_KEY         … CARTO のタイル URL(*.cartocdn.com)にだけ key= を付ける。
//                            他プロバイダの URL に差し替えた場合は付けない(キーを第三者へ流さない)。
//   MAP_TILE_URL_LIGHT    … ライトテーマのタイル URL テンプレート(Leaflet 形式 {s}/{z}/{x}/{y}/{r})
//   MAP_TILE_URL_DARK     … ダークテーマ用。省略時は MAP_TILE_URL_LIGHT を流用(それも無ければ CARTO dark)
//   MAP_TILE_ATTRIBUTION  … 地図右下の帰属表記(HTML)。URL を差し替えたら必ずそのプロバイダの表記にする
//   MAP_TILE_SUBDOMAINS   … {s} に入るサブドメイン(例: "abcd")。既定 "abcd"
//   MAP_TILE_MAX_ZOOM     … 既定 19

export interface MapTileConfig {
  urlLight: string;
  urlDark: string;
  attribution: string;
  subdomains: string;
  maxZoom: number;
  /** CARTO のキーを付けたか(キーの値そのものは載せない診断用) */
  cartoKeyApplied: boolean;
  /** 既定(CARTO)から URL を差し替えているか */
  customUrl: boolean;
}

const DEFAULT_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const DEFAULT_URL_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const DEFAULT_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** http(s) のテンプレートだけ受け付ける。それ以外は無視して既定に倒す。 */
function validUrl(name: string): string | null {
  const v = env(name);
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) {
    console.warn(`[global-overview] ${name} は http(s):// で始まる URL を指定してください。無視します。`);
    return null;
  }
  return v;
}

function isCartoUrl(url: string): boolean {
  // テンプレートの {s} 等をダミー値に置き換えてから URL として解析し、ブラウザと同じ規則で
  // ホストを決める(文字列で切り出すと "\\" や "@" を含む値で実際の送信先と食い違う)。
  try {
    const host = new URL(url.replace(/\{[^}]*\}/g, "a")).hostname.toLowerCase();
    return host === "cartocdn.com" || host.endsWith(".cartocdn.com");
  } catch {
    return false;
  }
}

function withCartoKey(url: string, key: string): string {
  if (!key || !isCartoUrl(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

export function getMapTileConfig(): MapTileConfig {
  const key = env("CARTO_API_KEY");
  const light = validUrl("MAP_TILE_URL_LIGHT");
  const dark = validUrl("MAP_TILE_URL_DARK");
  const urlLight = light ?? DEFAULT_URL_LIGHT;
  const urlDark = dark ?? light ?? DEFAULT_URL_DARK;
  const maxZoom = Number(env("MAP_TILE_MAX_ZOOM"));
  return {
    urlLight: withCartoKey(urlLight, key),
    urlDark: withCartoKey(urlDark, key),
    attribution: env("MAP_TILE_ATTRIBUTION") || DEFAULT_ATTRIBUTION,
    subdomains: env("MAP_TILE_SUBDOMAINS") || "abcd",
    maxZoom: Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : 19,
    cartoKeyApplied: Boolean(key) && (isCartoUrl(urlLight) || isCartoUrl(urlDark)),
    customUrl: Boolean(light || dark),
  };
}
