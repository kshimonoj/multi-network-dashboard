// 調査結果の共有(03 Task 2)で使うテキスト変換ユーティリティ。
//
// ここは「1件の調査結果 → 人が読むテキスト」への変換だけを持つ純関数の集まりで、
// DOM も React も触らない(ShareActions.tsx から使う)。
//
//  - stripMarkdown   … 回答本文(Markdown)をメール向けのプレーンテキストへ落とす
//  - buildShareText  … メタ情報(日時・サイト・ツール)+ 本文の共有テキストを組み立てる
//  - buildMailtoHref … mailto: URL を作る。長すぎる場合は本文を切り詰めて注記を足す
//
// 04 Task 4 で「セッション全体(一連のスレッド)」版を追加した(ファイル後半)。
//  - buildSessionShareText  … 全ターンを連結したプレーンテキスト(コピー用)
//  - buildSessionMailtoHref … 各ターンの要点だけを並べた要約(mailto 用)
//
// 33(i18n):
//  - React の外なので Context は張れない。investigate.ts と同じく getLang() + translate() で引く。
//  - ★ L-9: ヘッダの桁揃えは「全角スペースで手で整列」していた。英語では全角スペースが
//    不自然なので、**行テンプレートごと辞書に持たせ、padding も辞書の中に含める**
//    (ja は全角スペース / en は半角スペースで整列)。整列の責務をコードから辞書へ移す。
//  - 箇条書きの記号(ja「・」/ en「- 」)、mailto の文字数上限も言語別に持つ。

import { getLang, translate } from "../../../src/i18n";

export interface ShareReport {
  query: string;
  site: string | null; // null = サイト指定なし(横断調査)
  ts: string; // ISO 文字列
  model?: string | null;
  tools: string[]; // 実際に呼んだツール名(central_get_summary 等)
  platforms: string[]; // 使用プラットフォーム("central" | "mist")
  answer: string; // 回答本文(Markdown)
  // 失敗したターンの注記。単発の共有は成功時しかボタンを出さないので使わないが、
  // セッション共有(04 Task 4)は途中で失敗したターンも流れとして残すため、ここに理由を入れる。
  errorNote?: string | null;
  // セッション共有の印刷でのみ使う runId。印刷ツリーと画面側のターンを data-ni-turn で
  // 対応付け、描画済みのグラフ / トポロジ図 SVG を正しいターンへ複製するための目印。
  turnId?: string;
}

const K = "networkInvestigation.shareText";

/** 現在の表示言語で辞書を引く小さなラッパ(このファイル専用)。 */
function tr(key: string, params?: Record<string, string | number>): string {
  return translate(getLang(), key, params);
}

export function siteAnyLabel(): string {
  return tr(`${K}.siteAny`);
}

/** 辞書から取った文字列を正規表現に埋めるためのエスケープ。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// mailto: の URL 長は仕様上の上限は無いが、実装依存の上限がある(概ね 2000 文字前後)。
// 余裕を見て 1900 文字を超えないところで本文を切る。
export const MAILTO_MAX_URL_LENGTH = 1900;

/**
 * 文字数ベースの上限は言語で意味が変わる(28 findings のメモ)。
 * mailto: は本文を URL エンコードするので、日本語 1 文字 = %XX 3 個 = 9 文字に膨らむ。
 * 英語は 1 文字 = 1 文字なので、同じ URL 長でも遥かに多くの文字が載る。
 * 「切り詰め」自体は二分探索が担保するが、**切り詰めが起きる前の既定値**は言語別に持つ。
 */
interface LengthBudget {
  /** 単発メールのクエリ引用の上限 */
  mailQueryMax: number;
  /** セッションメールのクエリ引用の上限 */
  mailSessionQueryMax: number;
  /** セッションメールの 1 ターンあたりの要点の長さ */
  mailTurnLimit: number;
}
const BUDGETS: Record<"ja" | "en", LengthBudget> = {
  ja: { mailQueryMax: 60, mailSessionQueryMax: 40, mailTurnLimit: 120 },
  // 英語は 1 文字あたりのエンコード後の長さが約 1/9 なので、同じ体裁でも余裕がある。
  // 9 倍そのままでは 1 ターンが長くなりすぎて要約の意味が薄れるため 3 倍程度に留める。
  en: { mailQueryMax: 180, mailSessionQueryMax: 120, mailTurnLimit: 360 },
};
function budget(): LengthBudget {
  return BUDGETS[getLang() === "en" ? "en" : "ja"];
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 印刷 / PDF 保存のファイル名(81 Task 1) ----
//
// ブラウザは「PDF として保存」の既定のファイル名を document.title から作る。
// 以前は index.html の固定タイトル("Multi Network Dashboard")のままだったので、
// 何度 PDF を出しても同じ名前になり、区別できなかった。
// 印刷の直前だけ title を差し替える(shareUi.ts の usePrintOnMount)。
//
// 命名: <stem>_<サイト>_<YYYY-MM-DD>_<HHmm>
//   例) network-investigation_HOME-LAB_2026-08-14_1129
//       network-investigation-session_all-sites_2026-08-14_1131
// 日時はロケール非依存の固定書式にする(formatTimestamp と同じ方針。
// 表示言語でファイル名が変わると、同じ調査の PDF が言語ごとに別名になってしまうため、
// ここは辞書を引かず英数字の固定語("all-sites" 等)を使う)。

const PRINT_FILE_STEM = "network-investigation";
const PRINT_FILE_STEM_SESSION = "network-investigation-session";
/** サイト指定なし(横断調査)を表す語。表示ではなくファイル名なので翻訳しない。 */
const PRINT_FILE_NO_SITE = "all-sites";
/** セッション内でサイトが混在しているときの語。 */
const PRINT_FILE_MULTI_SITE = "multi-site";
/** サイト名部分の長さ上限(文字数)。長い名前でパスが破綻しないように切る。 */
const PRINT_FILE_SITE_MAX = 40;

/**
 * ファイル名に使えない文字を落とす。
 * - Windows / macOS で禁止・特別扱いされる文字(\ / : * ? " < > |)と制御文字を除去
 * - 空白は "-" に畳む(シェルやメール添付で扱いやすくするため)
 * - 末尾のドット・ハイフンを落とす(Windows は末尾ドットのファイルを作れない)
 * 日本語のサイト名はそのまま残す。ブラウザは UTF-8 でファイル名を書き、
 * macOS / Windows / Linux のいずれもそのまま扱えるため(NFKC で全角英数だけ半角へ寄せる)。
 */
export function sanitizeFileNamePart(s: string): string {
  const cleaned = (s || "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\s　]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return Array.from(cleaned).slice(0, PRINT_FILE_SITE_MAX).join("");
}

/** ファイル名用の日時。"YYYY-MM-DD_HHmm"(ロケール非依存)。 */
function fileTimestamp(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}${p(t.getMinutes())}`;
}

function printFileName(stem: string, site: string | null, iso: string): string {
  const sitePart = sanitizeFileNamePart(site || "") || PRINT_FILE_NO_SITE;
  return `${stem}_${sitePart}_${fileTimestamp(iso)}`;
}

/** 単発の調査結果を印刷 / PDF 保存するときの document.title。 */
export function buildPrintDocTitle(report: ShareReport): string {
  return printFileName(PRINT_FILE_STEM, report.site, report.ts);
}

/**
 * セッション全体を印刷 / PDF 保存するときの document.title。
 * サイトはターンを跨ぐことがあるので、
 *   全ターンが同じサイト → サイト名 / 全ターンがサイト指定なし → all-sites /
 *   混在 → multi-site
 * とする。日時は「最後に実行したターン」= 紙面の末尾に合わせる。
 */
export function buildSessionPrintDocTitle(s: SessionShareReport): string {
  const sites = new Set(s.turns.map((t) => (t.site || "").trim()));
  const named = [...sites].filter(Boolean);
  const site = sites.size === 1 ? (named[0] ?? "") : named.length > 0 ? PRINT_FILE_MULTI_SITE : "";
  const last = s.turns[s.turns.length - 1];
  return printFileName(PRINT_FILE_STEM_SESSION, site, last?.ts ?? new Date().toISOString());
}

export function platformLabel(p: string): string {
  return p === "central" ? "Central" : p === "mist" ? "Mist" : p;
}

export function siteLabel(site: string | null): string {
  return site && site.trim() ? site : siteAnyLabel();
}

// 重複を除いたツール名の並び(呼び出し順を保つ)。
export function uniqueTools(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ---- Markdown → プレーンテキスト ----
//
// Markdown.tsx が描画対象にしている記法(見出し/箇条書き/番号付き/太字/斜体/インラインコード/
// リンク/コードブロック)を、そのまま読めるテキストへ落とす。
// リンクは「ラベル (URL)」の形で URL も残す(メールで受け取った人が辿れるように)。
export function stripMarkdown(md: string): string {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLang = ""; // 開いているフェンスの言語(chart / topology は中身を出さない)

  for (const raw of lines) {
    const fence = raw.match(/^\s*```\s*([\w-]*)/);
    if (fence) {
      // コードフェンスの開始/終了行そのものは出さない。
      // chart / topology は画面専用の描画なので、開始時に注記だけ残し中身(JSON / mermaid)は捨てる。
      if (!inFence) {
        fenceLang = (fence[1] || "").toLowerCase();
        if (fenceLang === "chart") out.push(tr(`${K}.chartNote`));
        else if (fenceLang === "topology") out.push(tr(`${K}.topologyNote`));
      } else {
        fenceLang = "";
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (fenceLang !== "chart" && fenceLang !== "topology") out.push(raw);
      continue;
    }

    // GFM テーブル(81 Task 3)。プレーンテキストに罫線は引けないので、区切り行
    // (|---|---|)は捨て、枠のパイプだけ落として「列 | 列」の形で読めるようにする。
    // セル内の強調・リンクはこの下の共通処理でそのまま剥がれる。
    if (/^\s*\|/.test(raw) && /^[\s|:-]+$/.test(raw)) continue;

    let line = raw;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, "|").trim())
        .join(" | ");
    }
    line = line.replace(/^\s*(#{1,6})\s+/, ""); // 見出しマーカー
    // 箇条書き(ja「・」/ en「- 」)。辞書の値をそのまま置換文字列に混ぜると "$&" 等が
    // 展開されてしまうので、コールバックで組み立てる。
    line = line.replace(/^(\s*)[-*]\s+/, (_m, indent: string) => `${indent}${tr(`${K}.bullet`)}`);
    line = line.replace(/^(\s*)(\d+)\.\s+/, "$1$2. "); // 番号付き(そのまま読める形へ整える)
    line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)"); // リンク
    line = line.replace(/`([^`]+)`/g, "$1"); // インラインコード
    line = line.replace(/\*\*([^*]+)\*\*/g, "$1"); // 太字
    line = line.replace(/\*([^*]+)\*/g, "$1"); // 斜体
    // アンダースコア強調は「語中の _ を潰さない」ことを優先する。
    // ネットワーク系の回答には infra_dhcp_failure / last_seen のような識別子が頻出し、
    // 素朴に _..._ を剥がすと infradhcpfailure に化ける(実際に発生したため境界を厳しくした)。
    // 前が行頭/空白/開き括弧、後ろが行末/空白/句読点・閉じ括弧のときだけ強調とみなす。
    line = line.replace(/(^|[\s(（「『【])__([^_]+)__(?=$|[\s)）」』】、。,.:;!?])/g, "$1$2");
    line = line.replace(/(^|[\s(（「『【])_([^_\s][^_]*)_(?=$|[\s)）」』】、。,.:;!?])/g, "$1$2");
    out.push(line.trimEnd());
  }

  // 3 行以上続く空行は 1 行にまとめる。
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- 共有テキスト(メール本文 / クリップボード共通) ----

export interface ShareTextOptions {
  // 本文(回答)をこの文字数で打ち切る。未指定なら切らない。
  bodyLimit?: number;
  // ダッシュボードの URL(メールの末尾に添える)。
  sourceUrl?: string | null;
}

// L-9: 各行の「ラベル + 桁揃えの空白 + :」まで辞書のテンプレートに含める。
// ja は全角スペース、en は半角スペースで整列済みの文字列が入っている。
function headerLine(field: string, value: string | number): string {
  return tr(`${K}.header.${field}`, { value });
}

export function buildShareHeader(report: ShareReport): string {
  const tools = uniqueTools(report.tools);
  const lines = [
    headerLine("site", siteLabel(report.site)),
    headerLine("ts", formatTimestamp(report.ts)),
    headerLine("query", report.query),
  ];
  if (report.platforms.length > 0) {
    lines.push(headerLine("platforms", report.platforms.map(platformLabel).join(" / ")));
  }
  lines.push(headerLine("tools", tools.length > 0 ? tools.join(", ") : toolsNoneLabel()));
  if (report.model) lines.push(headerLine("model", report.model));
  return lines.join("\n");
}

/** 「(記録なし)」。印刷レイアウト側(report.toolsNone)と同じ文言を共有する。 */
export function toolsNoneLabel(): string {
  return tr("networkInvestigation.report.toolsNone");
}

export function buildShareText(report: ShareReport, opts: ShareTextOptions = {}): string {
  const header = buildShareHeader(report);
  const full = stripMarkdown(report.answer);
  const limited =
    opts.bodyLimit != null && full.length > opts.bodyLimit
      ? `${full.slice(0, opts.bodyLimit).trimEnd()}\n${tr(`${K}.truncatedNote`)}`
      : full;
  const parts = [tr(`${K}.docTitle`), "", header, "", tr(`${K}.resultDivider`), "", limited];
  if (opts.sourceUrl) parts.push("", tr(`${K}.dashboard`, { url: opts.sourceUrl }));
  return parts.join("\n");
}

export function buildSubject(report: ShareReport): string {
  return tr(`${K}.subject`, { site: siteLabel(report.site), ts: formatTimestamp(report.ts) });
}

// ---- メール本文 ----
//
// mailto: は URL に本文を載せるため、日本語 1 文字が %XX 3 個 = 9 文字に膨らむ。
// 上限 1900 文字はおよそ全角 200 文字ぶんしかなく、コピー用と同じ体裁のヘッダを付けると
// 回答本文がほとんど残らない(実データで確認)。そこでメールだけは
//   - 見出し行を落とす(件名に同じ情報がある)
//   - ヘッダをサイト / 日時 / クエリの 3 行に絞る(基盤・ツール・モデルは印刷/コピー側に任せる)
//   - 長いクエリを切る(上限は言語別: BUDGETS)
//   - 省略注記とダッシュボード URL を 1 行にまとめる
// として、回答本文に使える文字数を最大化する。

export function buildMailBody(report: ShareReport, opts: ShareTextOptions = {}): string {
  const max = budget().mailQueryMax;
  const q = report.query.length > max ? `${report.query.slice(0, max)}…` : report.query;
  const header = [
    tr(`${K}.mailHeader.site`, { value: siteLabel(report.site) }),
    tr(`${K}.mailHeader.ts`, { value: formatTimestamp(report.ts) }),
    tr(`${K}.mailHeader.query`, { value: q }),
  ].join("\n");

  const full = stripMarkdown(report.answer);
  const cut = opts.bodyLimit != null && full.length > opts.bodyLimit;
  const body = cut ? `${full.slice(0, opts.bodyLimit).trimEnd()}\n${tr(`${K}.truncatedShort`)}` : full;

  const parts = [header, "", tr(`${K}.resultDivider`), "", body];
  if (cut || opts.sourceUrl) {
    parts.push(
      "",
      tr(`${K}.seeDashboard`, {
        url: opts.sourceUrl ? tr(`${K}.urlSuffix`, { url: opts.sourceUrl }) : "",
      }),
    );
  }
  return parts.join("\n");
}

export interface MailtoResult {
  href: string;
  truncated: boolean; // 本文を切り詰めたか
  length: number; // 生成した mailto: URL の長さ
}

function mailtoUrl(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// mailto: URL を組み立てる。上限を超える場合は回答本文だけを二分探索で切り詰め、
// 末尾に「詳細はダッシュボードで」の注記を付ける(ヘッダのメタ情報は必ず残す)。
export function buildMailtoHref(
  report: ShareReport,
  opts: { sourceUrl?: string | null; maxUrlLength?: number } = {},
): MailtoResult {
  const max = opts.maxUrlLength ?? MAILTO_MAX_URL_LENGTH;
  const subject = buildSubject(report);
  const sourceUrl = opts.sourceUrl ?? null;

  const fullBody = buildMailBody(report, { sourceUrl });
  const fullHref = mailtoUrl(subject, fullBody);
  if (fullHref.length <= max) return { href: fullHref, truncated: false, length: fullHref.length };

  // 回答本文の採用文字数を二分探索(URL 長は文字数に単調増加するため成立する)。
  const answerLen = stripMarkdown(report.answer).length;
  let lo = 0;
  let hi = answerLen;
  let best = mailtoUrl(subject, buildMailBody(report, { bodyLimit: 0, sourceUrl }));
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const href = mailtoUrl(subject, buildMailBody(report, { bodyLimit: mid, sourceUrl }));
    if (href.length <= max) {
      best = href;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { href: best, truncated: true, length: best.length };
}

// =====================================================================
// 04 Task 4: セッション全体(一連のスレッド)の共有
// =====================================================================

export interface SessionShareReport {
  sessionId: string;
  turns: ShareReport[]; // ts 昇順(調査の流れの順)
}

// セッション内の全ターンから対象サイトをまとめる。
// 全ターンがサイト指定なしなら「指定なし(全サイト横断)」、複数サイトに跨るなら列挙する。
export function sessionSiteLabel(s: SessionShareReport): string {
  const sites = uniqueTools(s.turns.map((t) => t.site ?? ""));
  const named = sites.filter(Boolean);
  if (named.length === 0) return siteAnyLabel();
  const crossed = s.turns.some((t) => !t.site);
  const joined = named.join(", ");
  return crossed ? tr(`${K}.sessionSiteOther`, { sites: joined, any: siteAnyLabel() }) : joined;
}

export function sessionPlatforms(s: SessionShareReport): string[] {
  return uniqueTools(s.turns.flatMap((t) => t.platforms));
}

export function sessionTools(s: SessionShareReport): string[] {
  return uniqueTools(s.turns.flatMap((t) => t.tools));
}

export function sessionModels(s: SessionShareReport): string[] {
  return uniqueTools(s.turns.map((t) => t.model ?? ""));
}

// 「2026-07-23 10:14 〜 10:22」。1 ターンだけなら開始時刻のみ。
export function sessionPeriodLabel(s: SessionShareReport): string {
  if (s.turns.length === 0) return tr("networkInvestigation.report.none");
  const first = formatTimestamp(s.turns[0].ts);
  if (s.turns.length === 1) return first;
  const last = formatTimestamp(s.turns[s.turns.length - 1].ts);
  // 同日なら終わりは時刻だけにする(冗長さを避ける)。
  // formatTimestamp は言語に依らず "YYYY-MM-DD HH:MM" 固定なので、この位置指定は成立する。
  const sameDay = first.slice(0, 10) === last.slice(0, 10);
  return tr(`${K}.periodRange`, { first, last: sameDay ? last.slice(11) : last });
}

export function buildSessionSubject(s: SessionShareReport): string {
  const head = s.turns[0];
  const when = head ? formatTimestamp(head.ts) : "";
  return tr(`${K}.sessionSubject`, { site: sessionSiteLabel(s), ts: when, n: s.turns.length });
}

// 回答本文から「要点」を作る(メールの要約用)。
// Markdown を落としたうえで、意味のある行を先頭から limit 文字ぶんだけ拾って 1 行にまとめる。
export function summarizeAnswer(md: string, limit: number): string {
  // 行頭の箇条書き記号を落とす。stripMarkdown が付ける記号は言語別("・" / "- ")なので、
  // 今の言語の記号を**空白込みのまま**剥がす。英語で "-" だけを剥がす作りにすると
  // "-5% degradation" のような負値の行から先頭の "-" まで削ってしまう。
  const strip = new RegExp(`^(?:${escapeRegExp(tr(`${K}.bullet`))}|\\s)+`);
  const lines = stripMarkdown(md)
    .split("\n")
    .map((l) => l.replace(strip, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length > limit) {
      const rest = limit - len;
      if (rest > 8) out.push(`${l.slice(0, rest)}…`);
      else if (out.length === 0) out.push(`${l.slice(0, Math.max(limit, 0))}…`);
      break;
    }
    out.push(l);
    len += l.length;
  }
  return out.join(" / ");
}

// ---- コピー(セッション全体のプレーンテキスト) ----

export function buildSessionShareText(s: SessionShareReport, opts: ShareTextOptions = {}): string {
  const tools = sessionTools(s);
  const models = sessionModels(s).filter(Boolean);
  const platforms = sessionPlatforms(s);
  const head = [
    headerLine("site", sessionSiteLabel(s)),
    headerLine("period", sessionPeriodLabel(s)),
    headerLine("turns", s.turns.length),
  ];
  if (platforms.length > 0) head.push(headerLine("platforms", platforms.map(platformLabel).join(" / ")));
  head.push(headerLine("tools", tools.length > 0 ? tools.join(", ") : toolsNoneLabel()));
  if (models.length > 0) head.push(headerLine("model", models.join(", ")));

  const parts = [tr(`${K}.sessionDocTitle`), "", head.join("\n")];
  s.turns.forEach((t, i) => {
    parts.push(
      "",
      tr(`${K}.turnDivider`, {
        i: i + 1,
        n: s.turns.length,
        ts: formatTimestamp(t.ts),
        site: siteLabel(t.site),
      }),
      "",
      tr(`${K}.turnQuery`, { query: t.query }),
      "",
      t.errorNote ? tr(`${K}.turnFailed`, { note: t.errorNote }) : stripMarkdown(t.answer),
    );
  });
  if (opts.sourceUrl) parts.push("", tr(`${K}.dashboard`, { url: opts.sourceUrl }));
  return parts.join("\n");
}

// ---- メール(セッション全体の要約) ----
//
// 全ターンをそのまま入れると mailto: の URL 長上限(≒1900 文字。日本語は 1 文字 9 文字に膨らむ)を
// 確実に超える。そこで各ターンは「時刻 + クエリ + 回答の要点」の 3 点だけに畳み、
// 詳細はダッシュボードで見てもらう(上限は言語別: BUDGETS)。

export interface SessionMailOptions extends ShareTextOptions {
  /** 各ターンの要点に使う文字数 */
  turnLimit?: number;
  /** 本文に載せるターン数の上限(超える分は中間を省略する) */
  maxTurns?: number;
}

export function buildSessionMailBody(s: SessionShareReport, opts: SessionMailOptions = {}): string {
  const b = budget();
  const turnLimit = opts.turnLimit ?? b.mailTurnLimit;
  const maxTurns = Math.max(1, opts.maxTurns ?? s.turns.length);

  // 上限を超える場合は「最初のターン + 直近のターン」を残し、中間を省略する
  // (最初 = 何を調べ始めたか、直近 = どこに行き着いたか、が要約として最も効く)。
  let shown: Array<{ turn: ShareReport; no: number }> = s.turns.map((turn, i) => ({ turn, no: i + 1 }));
  let omitted = 0;
  if (s.turns.length > maxTurns) {
    omitted = s.turns.length - maxTurns;
    shown = [shown[0], ...shown.slice(shown.length - (maxTurns - 1))];
  }

  const lines = [
    tr(`${K}.mailHeader.site`, { value: sessionSiteLabel(s) }),
    tr(`${K}.mailHeader.period`, { value: sessionPeriodLabel(s), n: s.turns.length }),
    "",
    tr(`${K}.summaryDivider`),
  ];
  shown.forEach(({ turn, no }, i) => {
    if (omitted > 0 && i === 1) lines.push("", tr(`${K}.omittedTurns`, { n: omitted }));
    // 枠が厳しいときはクエリ側も一緒に詰める。要約メールでは「何を聞いたか」より
    // 「何が分かったか」を残したいので、クエリの上限を要点の長さに追随させる。
    const queryMax = Math.max(20, Math.min(b.mailSessionQueryMax, turnLimit));
    const q = turn.query.length > queryMax ? `${turn.query.slice(0, queryMax)}…` : turn.query;
    lines.push("", `${no}. [${formatTimestamp(turn.ts).slice(11)}] ${q}`);
    const point = turn.errorNote
      ? tr(`${K}.failedPoint`, { summary: summarizeAnswer(turn.errorNote, turnLimit) })
      : summarizeAnswer(turn.answer, turnLimit);
    if (point) lines.push(`   → ${point}`);
  });
  lines.push(
    "",
    tr(`${K}.mailFooter`, {
      n: s.turns.length,
      url: opts.sourceUrl ? tr(`${K}.urlSuffix`, { url: opts.sourceUrl }) : "",
    }),
  );
  return lines.join("\n");
}

// セッション全体の mailto: URL。まず各ターンの要点の長さを、それでも収まらなければ
// 載せるターン数を減らして上限に収める(どちらも URL 長に対して単調なので二分探索が成立する)。
export function buildSessionMailtoHref(
  s: SessionShareReport,
  opts: { sourceUrl?: string | null; maxUrlLength?: number } = {},
): MailtoResult {
  const max = opts.maxUrlLength ?? MAILTO_MAX_URL_LENGTH;
  const subject = buildSessionSubject(s);
  const sourceUrl = opts.sourceUrl ?? null;
  const build = (o: SessionMailOptions) => mailtoUrl(subject, buildSessionMailBody(s, { ...o, sourceUrl }));

  const fullLimit = Math.max(400, budget().mailTurnLimit);
  const full = build({ turnLimit: fullLimit });
  if (full.length <= max) return { href: full, truncated: false, length: full.length };

  let best: string | null = null;
  for (let maxTurns = s.turns.length; maxTurns >= 1; maxTurns--) {
    let lo = 0;
    let hi = fullLimit;
    let found: string | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const href = build({ turnLimit: mid, maxTurns });
      if (href.length <= max) {
        found = href;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found) {
      best = found;
      break;
    }
  }
  // ターン数を 1 まで削っても収まらない(極端に長いクエリ文)場合は、最小の本文で返す。
  const href = best ?? build({ turnLimit: 0, maxTurns: 1 });
  return { href, truncated: true, length: href.length };
}
