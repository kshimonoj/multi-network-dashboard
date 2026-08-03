// 40: 39 番の生録画(demo/work39/demo-raw.webm)を再利用して、
//     「所要時間の差」に加えて「2 ターン目の回答内容・粒度の差」も伝わる版を作る。
//     出力は demo/demo_03_model_comparison_v2.mp4(39 番の mp4 は上書きしない)。
//
// 39 番(demo/make-video39.mjs)からの変更点:
//
//   1. 速度区間を「早送り(3 倍)」だけでなく速度係数 v に一般化した。
//      v > 1 = 早送り、v < 1 = 引き伸ばし。3 倍速区間の範囲・倍率は 39 番と同一で、
//      速度差の印象は変えていない。
//   2. 2 ターン目の回答が画面に出ている区間(と締め)を 0.5 倍にして尺を作り、
//      そこに回答内容を比較する字幕を足した。この 3 区間は
//      ffmpeg の scene 検出でシーン変化ゼロ = 画面が静止しているので、
//      引き伸ばしてもスロー再生には見えない(instructions/40_findings.md)。
//   3. 字幕に出す「ツール呼び出し回数」「回答の文字数比」は手で書かず、
//      data/network-investigation/query-history.jsonl の該当レコードから読む。
//      画面の「呼び出したツール(N)」と一致させるため。
//
// 39 番までの成果物(mp4 / SRT / work39)には一切書き込まない。
// 中間ファイルは demo/work40/caps/ に分ける。
//
// 注: page.locator(...).screenshot は Playwright の API。JS の eval() は使っていない。
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SRCWORK = "demo/work39"; // 生録画とマークは 39 番のものを読むだけ(書き込まない)
const WORK = "demo/work40";
const CAPDIR = `${WORK}/caps`;
const RAW = `${SRCWORK}/demo-raw.webm`;
const HISTORY = "data/network-investigation/query-history.jsonl";
const OUT = "demo/demo_03_model_comparison_v2.mp4";
const SRT = "demo/subtitles40.ja.srt";

const meta = JSON.parse(readFileSync(`${SRCWORK}/marks.json`, "utf8"));
const M = Object.fromEntries(meta.marks.map((m) => [m.name, m.t / 1000]));
const DUR = meta.durationMs / 1000;

// ---- 実測の所要時間(画面のターン見出しから読み取った値)----
const dur = (side, i) => {
  const turns = meta[side]?.turns ?? [];
  return turns[i]?.durationText ?? meta[side]?.[`turn${i + 1}`]?.durationText ?? "—";
};
const S1 = dur("sonnet", 0);
const S2 = dur("sonnet", 1);
const L1 = dur("local", 0);
const L2 = dur("local", 1);
const sChipLabel = meta.sonnet?.chip?.label ?? "続けて調べる";
const sec = (side, i) => meta[side]?.turns?.[i]?.seconds ?? null;
const ratio = (a, b) => (a && b ? (a / b).toFixed(1) : null);
const R1 = ratio(sec("local", 0), sec("sonnet", 0));
const total = (side) => {
  const a = sec(side, 0);
  const b = sec(side, 1);
  return a != null && b != null ? (a + b).toFixed(1) : null;
};
const TS = total("sonnet");
const TL = total("local");
const RT = ratio(Number(TL), Number(TS));
const followupQuery = (meta.local?.followupQuery ?? meta.sonnet?.chip?.query ?? "").replace(
  /\s*\(site=[^)]*\)\s*$/,
  "",
);
const lFollowup =
  meta.local?.followupMode === "chip" ? `「${meta.local?.chip?.label ?? ""}」` : `「${followupQuery}」`;

// ---- 2 ターン目の回答内容(履歴レコードから)----
// 39 番の録画テイクで実際にサーバーが返したもの。同じ質問文の最後の実行を
// モデルごとに拾う(録画スクリプトは両モデルで同一のクエリ文を投げている)。
const pickTurn2 = (model) => {
  const rows = readFileSync(HISTORY, "utf8").trim().split("\n");
  for (let i = rows.length - 1; i >= 0; i--) {
    let r;
    try {
      r = JSON.parse(rows[i]);
    } catch {
      continue;
    }
    if (r.model === model && r.query === followupQuery) {
      return { calls: (r.calls ?? []).length, chars: (r.answer ?? "").length };
    }
  }
  return null;
};
const T2S = pickTurn2("sonnet");
const T2L = pickTurn2("local");
if (!T2S || !T2L) {
  throw new Error(`query-history.jsonl から 2 ターン目のレコードが見つかりません: "${followupQuery}"`);
}
// 文字数比は「約 N 割」に丸める(1 テイクの観測なので細かい桁は出さない)。
const lTenths = Math.round((T2L.chars / T2S.chars) * 10);
console.log(`turn2 sonnet: calls=${T2S.calls} chars=${T2S.chars}`);
console.log(`turn2 local : calls=${T2L.calls} chars=${T2L.chars} (${lTenths}/10)`);
console.log(`durations: sonnet ${S1} / ${S2}   local ${L1} / ${L2}`);

// ---- 速度区間(ソース時間)----
// 早送り(3 倍): 実行/チップ押下の直後 8 秒と回答表示の直前 3 秒は等倍で残し、
//               間の待ち時間だけを縮める。39 番と同じ式・同じ倍率。
// 引き伸ばし(0.5 倍): 回答が出そろって画面が静止している区間。字幕を読ませる尺を作る。
const SPEED = 3;
const SLOW = 0.5;
const regions = [];
const sped = {};
for (const [key, a, b] of [
  ["s1", M.s_run1 + 8, M.s_answer1 - 3],
  ["s2", M.s_click2 + 8, M.s_answer2 - 3],
  ["l1", M.l_run1 + 8, M.l_answer1 - 3],
  ["l2", M.l_click2 + 8, M.l_answer2 - 3],
]) {
  if (a != null && b != null && b - a >= 6) {
    regions.push({ a, b, v: SPEED, key });
    sped[key] = true;
  }
}
for (const [key, a, b] of [
  // 回答描画が落ち着くまで 0.5 秒だけ等倍で残してから伸ばす。
  ["slow_s2", M.s_answer2 + 0.5, M.s_durations],
  ["slow_l2", M.l_answer2 + 0.5, M.l_durations],
  // 締め。末尾 0.3 秒は等倍のまま残す(trim の端で切れないように)。
  ["slow_out", M.t_outro + 0.3, DUR - 0.3],
]) {
  if (a != null && b != null && b - a >= 1) regions.push({ a, b, v: SLOW, key });
}
regions.sort((x, y) => x.a - y.a);
for (let i = 1; i < regions.length; i++) {
  if (regions[i].a < regions[i - 1].b) throw new Error(`速度区間が重なっています: ${regions[i - 1].key} / ${regions[i].key}`);
}
console.log(
  "speed regions (src):",
  regions.map(
    (r) => `${r.key} ${r.a.toFixed(1)}-${r.b.toFixed(1)}s x${r.v} (${(r.b - r.a).toFixed(1)}s -> ${((r.b - r.a) / r.v).toFixed(1)}s)`,
  ),
);

// ---- ソース時間 → 出力時間の写像 ----
const out = (t) => {
  let o = 0;
  let cur = 0;
  for (const { a, b, v } of regions) {
    if (t <= a) return o + (t - cur);
    o += a - cur;
    if (t <= b) return o + (t - a) / v;
    o += (b - a) / v;
    cur = b;
  }
  return o + (t - cur);
};

// ---- 字幕の台本(from マーク → to マークの区間に texts を等分で割り当てる)----
// すべて「です・ます調」。回答内容についての文言は instructions/40_findings.md の
// 実測(履歴レコードの突き合わせ)に基づく。誇張表現は使わない。
const PLAN = [
  {
    from: "rec_start",
    to: "open_ni",
    offset: 1.4,
    texts: [
      "① 同じ質問を Sonnet と Local(gemma4:12b)で実行し、所要時間と回答内容を見比べます",
      "ネットワーク調査タブを開きます",
    ],
  },
  {
    from: "open_ni",
    to: "s_typed",
    texts: ["② まずはサイトに Home、モデルに Sonnet を選びます", `質問文は「${meta.query}」です`],
  },
  { from: "s_typed", to: "s_run1", texts: ["この質問文を、あとで Local 側にもそのまま使います"] },
  {
    from: "s_run1",
    to: "s_answer1",
    texts: [
      "③ Sonnet で実行します — AI が MCP 経由でツールを選び、調査を進めます",
      "呼び出したツールと取得件数がリアルタイムに表示されます",
      "対象サイトの概要から順に、デバイスやアラートへ掘り下げていきます",
      ...(sped.s1 ? ["回答が出るまでの待ち時間は 3 倍速で再生しています"] : []),
    ],
  },
  {
    from: "s_answer1",
    to: "s_chip",
    texts: [
      `回答が表示されました — Sonnet の 1 ターン目は ${S1} です`,
      // Local 側は候補が出ず手で投げることになるので、「自動で」を先に立てておく。
      "回答の下には「続けて調べる」の候補が自動で提示されます",
    ],
  },
  { from: "s_chip", to: "s_click2", texts: ["④ 回答の下の「続けて調べる」をワンクリックして深掘りします"] },
  {
    from: "s_click2",
    to: "s_answer2",
    texts: [
      `チップのクエリ「${sChipLabel}」が同じスレッドの 2 ターン目として実行されます`,
      "1 ターン目の回答を前提に、調査がさらに進みます",
      ...(sped.s2 ? ["待ち区間は Sonnet 側・Local 側ともに同じ 3 倍速で再生しています"] : []),
      "2 ターン目の呼び出しログも同じパネルに流れます",
      "AP 単位の詳細まで確認していきます",
      "深掘りの結論が出るまで待ちます",
    ],
  },
  {
    // 0.5 倍に伸ばした区間。Sonnet の 2 ターン目の回答が画面に出ている。
    from: "s_answer2",
    to: "s_durations",
    texts: [
      "前のターンを踏まえた深掘りの回答が得られます",
      `Sonnet はこのターンでツールを ${T2S.calls} 回呼び、AP 個別の詳細まで確認しています`,
      "回答では AP-515(シリアル CNJJKD565Y)を名指しし、他 2 台の使用率にも触れています",
    ],
  },
  {
    from: "s_durations",
    to: "l_new",
    texts: [
      `⑤ 各ターンの見出しに model と所要時間が記録されます(Sonnet: ${S1} / ${S2})`,
      "この 2 ターンを、次はローカルモデルでそのまま繰り返します",
    ],
  },
  {
    from: "l_new",
    to: "l_run1",
    texts: [
      "⑥ 新しい調査を始め、モデルを Local(gemma4:12b)に切り替えます",
      "同じ質問を、今度は手元のローカル LLM で実行します",
    ],
  },
  {
    from: "l_run1",
    to: "l_answer1",
    texts: [
      "⑦ ローカル実行では、MCP 呼び出しのループをサーバー側で回します",
      "同じ質問でも、回答までの待ち時間は Sonnet より大幅に長くなります",
      ...(sped.l1 ? ["この待ち区間は 3 倍速で再生しています — 実時間ではまだ待っている状態です"] : []),
      "ツール呼び出しの結果を受けて、ローカルモデルが回答を組み立てます",
      "画面の見え方は Sonnet のときと同じで、違うのは待ち時間だけです",
      "MCP サーバーへの接続・ツール呼び出しの記録も同じように残ります",
      "ローカル完結なので、問い合わせ内容を外部に出さずに調査できます",
      "回答が返ってくるまで、もう少し待ちます",
    ],
  },
  {
    from: "l_answer1",
    to: "l_chip",
    texts: [
      `Local の 1 ターン目は ${L1} でした(Sonnet は ${S1})`,
      ...(R1 ? [`同じ質問・同じサイトで、約 ${R1} 倍の差が出ています`] : []),
    ],
  },
  {
    from: "l_chip",
    to: "l_click2",
    texts:
      meta.local?.followupMode === "chip"
        ? ["⑧ Local でも「続けて調べる」のチップをワンクリックします"]
        : [
            "⑧ Local の回答には「続けて調べる」の候補が出なかったため、\n同じ追い質問を「このスレッドの続きとして実行する」で投げます",
          ],
  },
  {
    from: "l_click2",
    to: "l_answer2",
    texts: [
      `追い質問 ${lFollowup} を、同じスレッドの 2 ターン目として実行します`,
      sped.l2
        ? "2 ターン目も同じように待ち時間が発生します(3 倍速で再生しています)"
        : "2 ターン目も同じように待ち時間が発生します",
      "ローカル LLM では、ツール呼び出しのたびに手元のマシンで推論が走ります",
      "SSE ログには、ローカル実行でも同じように呼び出しが流れます",
    ],
  },
  {
    // 0.5 倍に伸ばした区間。Local の 2 ターン目の回答が画面に出ている。
    // このターンには候補チップが出ているので(1 ターン目とは違う)、⑧ の字幕と
    // 画面が食い違わないよう 1 枚目で触れておく。
    from: "l_answer2",
    to: "l_durations",
    texts: [
      "ローカルモデルでも深掘りの回答が得られ、今度は「続けて調べる」も出ています",
      `Local はこのターンでツールを ${T2L.calls} 回呼び、サイト概要の範囲で回答しています`,
      `AP 名やシリアルには触れず、回答の文字数も Sonnet 側の約 ${lTenths} 割です`,
    ],
  },
  {
    from: "l_durations",
    to: "t_timeline",
    texts: [
      `⑨ Local の所要時間は ${L1} / ${L2} です`,
      ...(TS && TL ? [`2 ターン合計では Sonnet ${TS}秒 に対して Local ${TL}秒 です`] : []),
    ],
  },
  {
    from: "t_timeline",
    to: "t_cards",
    texts: ["⑩ 実行タイムラインには、実行ごとに model と最終ターンの所要時間が残ります"],
  },
  {
    from: "t_cards",
    to: "t_outro",
    texts: [
      `上が Local(${L2})、下が Sonnet(${S2})— どちらも最終ターンの所要時間です`,
      `1 ターン目は Sonnet ${S1} に対し Local ${L1}${R1 ? `(約 ${R1} 倍)` : ""} でした`,
      ...(TS && TL && RT ? [`2 ターン合計は Sonnet ${TS}秒 / Local ${TL}秒 で、約 ${RT} 倍の差です`] : []),
    ],
  },
  {
    // 0.5 倍に伸ばした区間。
    from: "t_outro",
    to: "rec_end",
    texts: [
      "所要時間だけでなく、2 ターン目の回答の粒度にも違いが見られました",
      "クラウドモデルとローカルモデルを、同じ画面の数字と回答内容で比較できます",
    ],
  },
];

const MAX = 7.0; // 1 枚あたりの上限(秒・出力時間)
const MIN = 1.0; // これより短くなる区間は捨てる
const GAP = 0.12; // 字幕の切り替わりに入れる無表示の間

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
for (const c of caps) console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.text.replace(/\n/g, " / ")}`);

// ---- SRT(参照用・出力タイムライン基準)----
const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const sec2 = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${sec2},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(SRT, caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n"));

// ---- 字幕 PNG(透過)を Chromium で描く ----
// このホストの ffmpeg には drawtext / subtitles / ass フィルタが無いので(34 番の調査どおり)、
// 字幕 1 枚ごとに透過 PNG を作って overlay で焼き込む。
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

// ---- ffmpeg: trim + setpts + concat で速度変更 → overlay で字幕焼き込み → H.264 mp4 ----
const args = ["-y", "-i", RAW];
for (let i = 0; i < caps.length; i++) args.push("-i", `${CAPDIR}/cap${String(i).padStart(2, "0")}.png`);

const chain = [];

// 1) 速度変更: 等倍 / 3 倍速 / 0.5 倍のセグメントに切って連結する。
const parts = [];
let cursor = 0;
for (const { a, b, v } of regions) {
  if (a - cursor > 0.05) parts.push({ s: cursor, e: a, v: 1 });
  parts.push({ s: a, e: b, v });
  cursor = b;
}
parts.push({ s: cursor, e: null, v: 1 });
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
