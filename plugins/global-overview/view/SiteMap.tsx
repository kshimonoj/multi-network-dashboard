// サイト位置の MAP(06 Task 2-4)。
//
// 参考画像には無い追加要素。緯度経度は snapshot の sites[].lat/lng を使う
// (aggregate.ts が API 実データを優先し、欠けている分だけ site-map.ts の対応表で補完済み)。
//
// ピンの読み方 — 2 つの軸を 1 つのピンに載せる:
//   ・枠線の色  … プラットフォーム(Central = オレンジ / Mist = グリーン)
//   ・塗りの色  … 状態(Down あり = 赤 / アラートあり = 琥珀 / 正常 = 緑 / デバイス 0 = グレー)
//   ・中の文字  … C / M(色覚に依らずプラットフォームが分かるように)
// 判定順は「Down > アラート > 正常」。Down しているサイトはアラートの有無に関わらず赤にする。
//
// 依存は既存の leaflet(package.json)。既定マーカーの PNG は使わず divIcon で描くので、
// Leaflet の画像アセット解決(bundler 依存でハマりやすい)を踏まない。

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ALERT_LABEL, PLATFORM_SHORT, type SiteRow } from "./types";

const PLATFORM_COLOR: Record<"central" | "mist", string> = {
  central: "#ff8a3d",
  mist: "#22c55e",
};

type SiteState = "down" | "alert" | "ok" | "empty";

const STATE_COLOR: Record<SiteState, string> = {
  down: "#ef4444",
  alert: "#f2a65a",
  ok: "#22c55e",
  empty: "#8892a0",
};

export const STATE_LABEL: Record<SiteState, string> = {
  down: "Down あり",
  alert: "アラートあり",
  ok: "正常",
  empty: "デバイス未登録",
};

export function siteState(s: SiteRow): SiteState {
  if (s.deviceDown > 0) return "down";
  if (s.alerts > 0) return "alert";
  if (s.deviceTotal === 0) return "empty";
  return "ok";
}

// タイルは CARTO(OSM ベース)。ライト/ダークで別レイヤに差し替えて、
// テーマ切替時にも地図だけ浮かないようにする。
const TILE_URL: Record<"light" | "dark", string> = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
};
const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function markerHtml(s: SiteRow): string {
  const st = siteState(s);
  const letter = s.platform === "central" ? "C" : "M";
  return (
    `<span class="go-pin go-pin-${st}" style="background:${STATE_COLOR[st]};border-color:${PLATFORM_COLOR[s.platform]}">` +
    `${letter}</span>`
  );
}

function popupHtml(s: SiteRow): string {
  const st = siteState(s);
  const health = s.healthScore === null ? "—" : String(s.healthScore);
  const healthNote = s.healthScore === null ? '<span class="go-pop-note">(未取得)</span>' : "";
  return `
    <div class="go-pop">
      <div class="go-pop-head">
        <span class="go-pop-dot" style="background:${STATE_COLOR[st]};border-color:${PLATFORM_COLOR[s.platform]}"></span>
        <span class="go-pop-name">${escapeHtml(s.siteName)}</span>
      </div>
      <div class="go-pop-plat">${PLATFORM_SHORT[s.platform]} — ${STATE_LABEL[st]}</div>
      <table class="go-pop-tbl">
        <tr><th>デバイス</th><td>${s.deviceTotal} 台 (Up ${s.deviceUp} / Down ${s.deviceDown})</td></tr>
        <tr><th>AP</th><td>${s.devices.ap.total} (Up ${s.devices.ap.up} / Down ${s.devices.ap.down})</td></tr>
        <tr><th>Switch</th><td>${s.devices.switch.total} (Up ${s.devices.switch.up} / Down ${s.devices.switch.down})</td></tr>
        <tr><th>Gateway</th><td>${s.devices.gateway.total} (Up ${s.devices.gateway.up} / Down ${s.devices.gateway.down})</td></tr>
        <tr><th>クライアント</th><td>${s.clients}</td></tr>
        <tr><th>アラート</th><td>${s.alerts} <span class="go-pop-note">(${ALERT_LABEL[s.platform]})</span></td></tr>
        <tr><th>健全性</th><td>${health} ${healthNote}</td></tr>
      </table>
    </div>`;
}

/**
 * 完全に同じ緯度経度のサイト(例: <SITE_X> / <SITE_Y>)は重なって片方が押せなくなる。
 * 重複した分だけ決め打ちの微小オフセット(約 30m 相当)を円周上に散らす。
 * 表示位置がずれるのは重複時だけで、単独サイトは実座標のまま。
 */
function spread(sites: SiteRow[]): Array<{ site: SiteRow; lat: number; lng: number }> {
  const seen = new Map<string, number>();
  const out: Array<{ site: SiteRow; lat: number; lng: number }> = [];
  for (const s of sites) {
    if (s.lat === null || s.lng === null) continue;
    const key = `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) {
      out.push({ site: s, lat: s.lat, lng: s.lng });
    } else {
      const angle = (n * 2 * Math.PI) / 6;
      const r = 0.00028 * (1 + Math.floor((n - 1) / 6));
      out.push({
        site: s,
        lat: s.lat + r * Math.sin(angle),
        lng: s.lng + r * Math.cos(angle) * 1.2,
      });
    }
  }
  return out;
}

/** サイトの一意キー(テーブル行の選択状態と突き合わせる)。 */
export function siteKey(s: { platform: string; siteId: string | null; siteName: string }): string {
  return `${s.platform}:${s.siteId ?? s.siteName}`;
}

export function SiteMap({
  sites,
  theme,
  active,
  focusKey,
  fitToken,
  onSelect,
}: {
  sites: SiteRow[];
  theme: "dark" | "light";
  /** タブが表示中か。非表示 → 表示になった瞬間に invalidateSize が要る。 */
  active: boolean;
  /** テーブル行などから選ばれたサイト。該当ピンへ寄せてポップアップを開く。 */
  focusKey?: string | null;
  /** 値が変わるたびに全ピンが入る表示へ戻す(「全体表示」ボタン用)。 */
  fitToken?: number;
  onSelect?: (site: SiteRow) => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const fittedRef = useRef(false);

  const points = useMemo(() => spread(sites), [sites]);

  // 地図本体は一度だけ作る。
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      center: [36.2, 138.25],
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
      // ダッシュボード内に置くため、ページのスクロールを奪わないようにする。
      scrollWheelZoom: false,
    });
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // タイルはテーマに合わせて貼り替える。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    tileRef.current = L.tileLayer(TILE_URL[theme], {
      attribution: TILE_ATTRIB,
      maxZoom: 19,
      subdomains: "abcd",
    }).addTo(map);
  }, [theme]);

  // マーカーの再構築(スナップショット更新のたび)。
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersRef.current.clear();
    if (points.length === 0) return;

    for (const p of points) {
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "go-pin-wrap",
          html: markerHtml(p.site),
          iconSize: [22, 22],
          iconAnchor: [11, 11],
          popupAnchor: [0, -12],
        }),
        title: `${p.site.siteName}(${PLATFORM_SHORT[p.site.platform]})`,
        // Down しているサイトを他のピンより前面に出す。
        zIndexOffset: siteState(p.site) === "down" ? 1000 : siteState(p.site) === "alert" ? 500 : 0,
      });
      marker.bindPopup(popupHtml(p.site), { className: "go-pop-wrap", maxWidth: 300 });
      if (onSelect) marker.on("click", () => onSelect(p.site));
      marker.addTo(layer);
      markersRef.current.set(siteKey(p.site), marker);
    }

    // 初回だけ全ピンが入るように寄せる。以降はユーザーの操作した表示位置を尊重する。
    if (!fittedRef.current) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 11 });
      fittedRef.current = true;
    }
  }, [points, onSelect]);

  // 「全体表示」。初回の fitBounds と同じ範囲へ戻す(fitToken の初期値では動かさない)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToken || points.length === 0) return;
    map.closePopup();
    map.fitBounds(
      L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])),
      { padding: [36, 36], maxZoom: 11 },
    );
  }, [fitToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // サイトが選ばれたら、そのピンへ寄せてポップアップを開く。
  // 首都圏のようにサイトが密集する場所は広域表示だとピンが重なって選べないため、
  // テーブル行 → 地図の導線をここで補う。
  //
  // 非表示(active=false)のあいだは何もしない。13 番で行クリックが「詳細ページへ遷移」も
  // 兼ねるようになり、地図が display:none の状態で openPopup が走ると Leaflet が
  // 幅 0 でポップアップを組んでしまい、一覧に戻ったとき縦長に潰れて出る。
  // 表示に戻った時点(active が true に変わる)で改めて開き直す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusKey || !active) return;
    const marker = markersRef.current.get(focusKey);
    if (!marker) return;
    // invalidateSize(下の effect が 60ms 後)を待ってから開く。
    const id = window.setTimeout(() => {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
      marker.openPopup();
    }, 90);
    return () => window.clearTimeout(id);
  }, [focusKey, points, active]);

  // 非表示中に作られた/リサイズされた地図はタイルが欠けるので、表示になったら計り直す。
  useEffect(() => {
    if (!active) return;
    const map = mapRef.current;
    if (!map) return;
    const id = window.setTimeout(() => map.invalidateSize(), 60);
    return () => window.clearTimeout(id);
  }, [active, points]);

  // 親要素のリサイズ(ウィンドウ幅変更・パネル折りたたみ)にも追従させる。
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => mapRef.current?.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return <div className="go-map" ref={elRef} />;
}

export { PLATFORM_COLOR, STATE_COLOR };
