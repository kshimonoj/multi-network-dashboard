// 36: 早送り編集 + 字幕の焼き込み + mp4 化(35 番の demo/make-video35.mjs がベース)。
//
// 35 番からの変更点:
//   - 調査実行中(MCP 呼び出し待ち)の単調な区間を trim + setpts + concat で 3 倍速にする。
//     区間はマーク(n1_run / n1_answer, f_click / f_answer)から自動で決める。
//   - 字幕はすべて「です・ます調」。
//   - 字幕のタイミングは、早送り後の出力タイムラインに写像してから割り当てる。
//
// 37 番: 早送り区間に表示していた「▶▶ 3倍速」バッジのオーバーレイを削除(早送り自体は維持)。
// タイミングは demo/work36/marks.json(録画スクリプトが実際に書き出した時刻)から作る。
// このホストの ffmpeg には drawtext / subtitles / ass フィルタが無いので(34 番の調査どおり)、
// 字幕 1 枚ごとに透過 PNG を作って overlay で焼き込む。参照用に SRT も出す。
// 34 / 35 番の成果物には一切触らない。
//
// 注: page.locator(...).screenshot は Playwright の API。JS の eval() は使っていない。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORK = "demo/work36";
const CAPDIR = `${WORK}/caps`;
const RAW = `${WORK}/demo-raw.webm`;
const OUT = "demo/demo_02b_event_to_investigation_v2.mp4";
const SRT = "demo/subtitles36.ja.srt";

const meta = JSON.parse(readFileSync(`${WORK}/marks.json`, "utf8"));
const M = Object.fromEntries(meta.marks.map((m) => [m.name, m.t / 1000]));
const P = meta.picked;
const CHIP = meta.chip ?? { label: "" };
const DUR = meta.durationMs / 1000;

// ---- 早送り区間(ソース時間)----
// 実行ボタン/チップ押下の直後 8 秒(ルーティング判定・最初の呼び出し)と、
// 回答表示の直前 3 秒は等倍で残し、間の待ち時間だけを 3 倍速にする。
const SPEED = 3;
const regions = [];
for (const [a, b] of [
  [M.n1_run + 8, M.n1_answer - 3],
  [M.f_click + 8, M.f_answer - 3],
]) {
  if (a != null && b != null && b - a >= 6) regions.push([a, b]);
}
console.log(
  "speed regions (src):",
  regions.map(([a, b]) => `${a.toFixed(1)}-${b.toFixed(1)}s (${(b - a).toFixed(1)}s -> ${((b - a) / SPEED).toFixed(1)}s)`),
);

// ---- ソース時間 → 出力時間の写像 ----
// regions の内側は 1/SPEED、それ以外は等倍。
const out = (t) => {
  let o = 0;
  let cur = 0;
  for (const [a, b] of regions) {
    if (t <= a) return o + (t - cur);
    o += a - cur;
    if (t <= b) return o + (t - a) / SPEED;
    o += (b - a) / SPEED;
    cur = b;
  }
  return o + (t - cur);
};

// ---- 字幕の台本(from マーク → to マークの区間に、texts を等分で割り当てる)----
// すべて「です・ます調」。区間は出力タイムライン上で等分する。
const PLAN = [
  {
    from: "rec_start",
    to: "e1_filter",
    offset: 1.6, // 0〜1.3 秒は Global Overview が映っているので、タブ切替後から出す
    texts: [
      "① Event / Alert タブで、Central / Mist のイベント・アラートを横断で確認します",
      "この中から認証(authentication)関連の事象を探します",
    ],
  },
  {
    from: "e1_filter",
    to: "e1_filtered",
    texts: ["種別を「アラート」に絞り、「auth」で検索して認証関連のアラートを探します"],
  },
  {
    from: "e1_filtered",
    to: "e1_pick",
    texts: [`802.1X 認証サーバー無応答のアラートが見つかりました(${P.site} / ${P.platform} / ${P.severity})`],
  },
  { from: "e1_pick", to: "e1_click", texts: ["この行の「調査する」を押します"] },
  {
    from: "n1_prefilled",
    to: "n1_run",
    texts: [
      "② ネットワーク調査タブへ自動で切り替わります",
      "事案の要約からクエリ文が事前入力され、サイトも自動選択されます",
    ],
  },
  {
    from: "n1_run",
    to: "n1_answer",
    texts: [
      "③ そのまま「実行」します — AI が MCP 経由で調査を始めます",
      "Central / Mist のどちらに問い合わせるかは AI が判断します",
      "呼び出したツールと取得件数がリアルタイムに表示されます",
      "対象サイトの概要から順に、アラートや直近イベントへ掘り下げていきます",
      "回答に至るまでの過程をすべて追うことができます",
    ],
  },
  {
    from: "n1_answer",
    to: "f_chip",
    texts: [
      "原因の兆候や影響範囲まで整理された回答が表示されます",
      "回答の下には「続けて調べる」の候補が提示されます",
    ],
  },
  {
    from: "f_chip",
    to: "f_click",
    texts: ["④ 回答の下に提示される「続けて調べる」のチップをワンクリックします"],
  },
  {
    from: "f_click",
    to: "f_answer",
    texts: [
      `チップのクエリ「${CHIP.label}」が、同じスレッドの 2 ターン目としてすぐに実行されます`,
      "1 ターン目の回答を前提に、調査がさらに進みます",
      "2 ターン目の呼び出しログも同じパネルに流れます",
      "深掘りの結論が出るまで待ちます",
    ],
  },
  {
    from: "f_answer",
    to: "s_thread",
    texts: [
      "前のターンを踏まえた、深掘りの回答が得られます",
      "2 ターン目の回答も同じスレッドに積み重なります",
    ],
  },
  { from: "s_thread", to: "s_outro", texts: ["⑤ 2 ターンの調査が 1 つのセッションとして記録されます"] },
  { from: "s_outro", to: "rec_end", texts: ["スレッド全体の共有や印刷 / PDF 化も、そのまま行えます"] },
];

const MAX = 7.0; // 1 枚あたりの上限(秒・出力時間)
const MIN = 1.0; // これより短くなる区間は捨てる
const GAP = 0.12; // 字幕の切り替わりに入れる無表示の間

// ---- タイミング計算(出力タイムライン上で等分)----
const caps = [];
for (const seg of PLAN) {
  const sa = M[seg.from] == null ? null : M[seg.from] + (seg.offset ?? 0);
  const sb = M[seg.to];
  if (sa == null || sb == null) continue;
  const a = out(sa);
  const b = out(sb);
  if (b - a < MIN) continue;
  let n = seg.texts.length;
  while ((b - a) / n > MAX) n += seg.texts.length;
  const span = (b - a) / n;
  for (let i = 0; i < n; i++) {
    const start = a + i * span;
    const end = start + span - GAP;
    if (end - start < 0.5) continue;
    caps.push({ start, end, text: seg.texts[i % seg.texts.length] });
  }
}
console.log(`captions: ${caps.length}`);
for (const c of caps) console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text}`);

// ---- SRT(参照用・出力タイムライン基準)----
const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(SRT, caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n"));

// ---- 字幕 PNG(透過)を Chromium で描く ----
rmSync(CAPDIR, { recursive: true, force: true });
mkdirSync(CAPDIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: meta.width, height: 300 }, deviceScaleFactor: 2 });
const capHtml = (inner) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;}
  .wrap{display:flex;justify-content:center;padding:8px 0;}
  .cap{
    max-width:${meta.width - 160}px;
    box-sizing:border-box;
    padding:14px 30px;
    border-radius:12px;
    background:rgba(12,18,26,0.86);
    border:1px solid rgba(255,255,255,0.18);
    color:#fff;
    font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
    font-size:30px;
    font-weight:600;
    line-height:1.45;
    letter-spacing:0.01em;
    text-align:center;
    white-space:pre-wrap;
  }</style>${inner}`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
for (let i = 0; i < caps.length; i++) {
  await page.setContent(capHtml(`<div class="wrap"><div class="cap">${esc(caps[i].text)}</div></div>`));
  await page
    .locator(".cap")
    .screenshot({ path: `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`, omitBackground: true });
}
await browser.close();
console.log(`caption pngs -> ${CAPDIR}`);

// ---- ffmpeg: trim + setpts + concat で早送り → overlay で字幕焼き込み → H.264 mp4 ----
const args = ["-y", "-i", RAW];
for (let i = 0; i < caps.length; i++) args.push("-i", `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`);

const chain = [];

// 1) 早送り: 等倍/3 倍速のセグメントに切って連結する。
const bounds = [0];
for (const [a, b] of regions) bounds.push(a, b);
const segs = [];
for (let i = 0; i < bounds.length; i += 2) {
  // 等倍区間
  const s = bounds[i];
  const e = i + 1 < bounds.length ? bounds[i + 1] : null;
  segs.push({ s, e, v: 1 });
  // 直後の早送り区間
  if (e != null) segs.push({ s: e, e: bounds[i + 2] ?? null, v: SPEED });
}
// 末尾の null セグメント(regions が動画末尾に無い場合)を整理
const parts = segs.filter((x) => x.e == null || x.e - x.s > 0.05);
parts.forEach((seg, i) => {
  const t = seg.e == null ? `trim=start=${seg.s.toFixed(3)}` : `trim=start=${seg.s.toFixed(3)}:end=${seg.e.toFixed(3)}`;
  const pts = seg.v === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${seg.v}`;
  chain.push(`[0:v]${t},${pts}[p${i}]`);
});
chain.push(`${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=1:a=0[base]`);

// 2) 字幕 PNG は deviceScaleFactor=2 で描いたので 1/2 に縮めてから重ねる。
for (let i = 0; i < caps.length; i++) chain.push(`[${i + 1}:v]scale=iw/2:-1[c${i}]`);

let cur = "base";
for (let i = 0; i < caps.length; i++) {
  const next = `v${i}`;
  chain.push(
    `[${cur}][c${i}]overlay=x=(W-w)/2:y=H-h-48:enable='between(t,${caps[i].start.toFixed(3)},${caps[i].end.toFixed(3)})'[${next}]`,
  );
  cur = next;
}

args.push(
  "-filter_complex",
  chain.join(";"),
  "-map",
  `[${cur}]`,
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "22",
  "-pix_fmt",
  "yuv420p",
  "-r",
  "25",
  "-movflags",
  "+faststart",
  OUT,
);

console.log("running ffmpeg…");
execFileSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
console.log(`\ndone -> ${OUT}  (output ~${out(DUR).toFixed(1)}s from src ${DUR.toFixed(1)}s)`);
