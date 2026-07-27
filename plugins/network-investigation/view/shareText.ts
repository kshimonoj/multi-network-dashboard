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

export const SITE_ANY_LABEL = "指定なし(全サイト横断)";

// mailto: の URL 長は仕様上の上限は無いが、実装依存の上限がある(概ね 2000 文字前後)。
// 余裕を見て 1900 文字を超えないところで本文を切る。
export const MAILTO_MAX_URL_LENGTH = 1900;

const TRUNCATED_NOTE = "…(以下省略)\n\n※本文が長いため冒頭のみ引用しています。詳細はダッシュボードでご確認ください。";

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function platformLabel(p: string): string {
  return p === "central" ? "Central" : p === "mist" ? "Mist" : p;
}

export function siteLabel(site: string | null): string {
  return site && site.trim() ? site : SITE_ANY_LABEL;
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
        if (fenceLang === "chart") out.push("(グラフはダッシュボード上で表示されます)");
        else if (fenceLang === "topology") out.push("(トポロジ図はダッシュボード上で表示されます)");
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

    let line = raw;
    line = line.replace(/^\s*(#{1,6})\s+/, ""); // 見出しマーカー
    line = line.replace(/^(\s*)[-*]\s+/, "$1・"); // 箇条書き
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

export function buildShareHeader(report: ShareReport): string {
  const tools = uniqueTools(report.tools);
  const lines = [
    `■ 対象サイト : ${siteLabel(report.site)}`,
    `■ 実行日時   : ${formatTimestamp(report.ts)}`,
    `■ 調査クエリ : ${report.query}`,
  ];
  if (report.platforms.length > 0) {
    lines.push(`■ 対象基盤   : ${report.platforms.map(platformLabel).join(" / ")}`);
  }
  lines.push(`■ 使用ツール : ${tools.length > 0 ? tools.join(", ") : "(記録なし)"}`);
  if (report.model) lines.push(`■ モデル     : ${report.model}`);
  return lines.join("\n");
}

export function buildShareText(report: ShareReport, opts: ShareTextOptions = {}): string {
  const header = buildShareHeader(report);
  const full = stripMarkdown(report.answer);
  const limited =
    opts.bodyLimit != null && full.length > opts.bodyLimit
      ? `${full.slice(0, opts.bodyLimit).trimEnd()}\n${TRUNCATED_NOTE}`
      : full;
  const parts = ["【ネットワーク調査レポート】", "", header, "", "── 調査結果 ──", "", limited];
  if (opts.sourceUrl) parts.push("", `ダッシュボード: ${opts.sourceUrl}`);
  return parts.join("\n");
}

export function buildSubject(report: ShareReport): string {
  return `[ネットワーク調査] ${siteLabel(report.site)} ${formatTimestamp(report.ts)}`;
}

// ---- メール本文 ----
//
// mailto: は URL に本文を載せるため、日本語 1 文字が %XX 3 個 = 9 文字に膨らむ。
// 上限 1900 文字はおよそ全角 200 文字ぶんしかなく、コピー用と同じ体裁のヘッダを付けると
// 回答本文がほとんど残らない(実データで確認)。そこでメールだけは
//   - 見出し行を落とす(件名に同じ情報がある)
//   - ヘッダをサイト / 日時 / クエリの 3 行に絞る(基盤・ツール・モデルは印刷/コピー側に任せる)
//   - 長いクエリは 60 文字で切る
//   - 省略注記とダッシュボード URL を 1 行にまとめる
// として、回答本文に使える文字数を最大化する。
const MAIL_QUERY_MAX = 60;

export function buildMailBody(report: ShareReport, opts: ShareTextOptions = {}): string {
  const q =
    report.query.length > MAIL_QUERY_MAX ? `${report.query.slice(0, MAIL_QUERY_MAX)}…` : report.query;
  const header = [
    `対象サイト: ${siteLabel(report.site)}`,
    `実行日時: ${formatTimestamp(report.ts)}`,
    `調査クエリ: ${q}`,
  ].join("\n");

  const full = stripMarkdown(report.answer);
  const cut = opts.bodyLimit != null && full.length > opts.bodyLimit;
  const body = cut ? `${full.slice(0, opts.bodyLimit).trimEnd()}\n…(以下省略)` : full;

  const parts = [header, "", "── 調査結果 ──", "", body];
  if (cut || opts.sourceUrl) {
    parts.push("", `詳細はダッシュボードでご確認ください${opts.sourceUrl ? `: ${opts.sourceUrl}` : ""}`);
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
  if (named.length === 0) return SITE_ANY_LABEL;
  const crossed = s.turns.some((t) => !t.site);
  return named.join(", ") + (crossed ? ` ほか(${SITE_ANY_LABEL})` : "");
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
  if (s.turns.length === 0) return "—";
  const first = formatTimestamp(s.turns[0].ts);
  if (s.turns.length === 1) return first;
  const last = formatTimestamp(s.turns[s.turns.length - 1].ts);
  // 同日なら終わりは時刻だけにする(冗長さを避ける)。
  const sameDay = first.slice(0, 10) === last.slice(0, 10);
  return `${first} 〜 ${sameDay ? last.slice(11) : last}`;
}

export function buildSessionSubject(s: SessionShareReport): string {
  const head = s.turns[0];
  const when = head ? formatTimestamp(head.ts) : "";
  return `[ネットワーク調査] ${sessionSiteLabel(s)} ${when}(${s.turns.length}ターン)`;
}

// 回答本文から「要点」を作る(メールの要約用)。
// Markdown を落としたうえで、意味のある行を先頭から limit 文字ぶんだけ拾って 1 行にまとめる。
export function summarizeAnswer(md: string, limit: number): string {
  const lines = stripMarkdown(md)
    .split("\n")
    .map((l) => l.replace(/^[・\s]+/, "").trim())
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
    `■ 対象サイト : ${sessionSiteLabel(s)}`,
    `■ 期間       : ${sessionPeriodLabel(s)}`,
    `■ ターン数   : ${s.turns.length}`,
  ];
  if (platforms.length > 0) head.push(`■ 対象基盤   : ${platforms.map(platformLabel).join(" / ")}`);
  head.push(`■ 使用ツール : ${tools.length > 0 ? tools.join(", ") : "(記録なし)"}`);
  if (models.length > 0) head.push(`■ モデル     : ${models.join(", ")}`);

  const parts = ["【ネットワーク調査レポート(調査スレッド)】", "", head.join("\n")];
  s.turns.forEach((t, i) => {
    parts.push(
      "",
      `── ターン ${i + 1}/${s.turns.length} ・ ${formatTimestamp(t.ts)} ・ ${siteLabel(t.site)} ──`,
      "",
      `■ クエリ: ${t.query}`,
      "",
      t.errorNote ? `(このターンは失敗しました)${t.errorNote}` : stripMarkdown(t.answer),
    );
  });
  if (opts.sourceUrl) parts.push("", `ダッシュボード: ${opts.sourceUrl}`);
  return parts.join("\n");
}

// ---- メール(セッション全体の要約) ----
//
// 全ターンをそのまま入れると mailto: の URL 長上限(≒1900 文字。日本語は 1 文字 9 文字に膨らむ)を
// 確実に超える。そこで各ターンは「時刻 + クエリ + 回答の要点」の 3 点だけに畳み、
// 詳細はダッシュボードで見てもらう。
const MAIL_SESSION_QUERY_MAX = 40;

export interface SessionMailOptions extends ShareTextOptions {
  /** 各ターンの要点に使う文字数 */
  turnLimit?: number;
  /** 本文に載せるターン数の上限(超える分は中間を省略する) */
  maxTurns?: number;
}

export function buildSessionMailBody(s: SessionShareReport, opts: SessionMailOptions = {}): string {
  const turnLimit = opts.turnLimit ?? 120;
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
    `対象サイト: ${sessionSiteLabel(s)}`,
    `期間: ${sessionPeriodLabel(s)}(${s.turns.length}ターン)`,
    "",
    "── 調査サマリ ──",
  ];
  shown.forEach(({ turn, no }, i) => {
    if (omitted > 0 && i === 1) lines.push("", `…(中間の ${omitted} ターンは省略)`);
    // 枠が厳しいときはクエリ側も一緒に詰める。要約メールでは「何を聞いたか」より
    // 「何が分かったか」を残したいので、クエリの上限を要点の長さに追随させる。
    const queryMax = Math.max(20, Math.min(MAIL_SESSION_QUERY_MAX, turnLimit));
    const q = turn.query.length > queryMax ? `${turn.query.slice(0, queryMax)}…` : turn.query;
    lines.push("", `${no}. [${formatTimestamp(turn.ts).slice(11)}] ${q}`);
    const point = turn.errorNote
      ? `(失敗)${summarizeAnswer(turn.errorNote, turnLimit)}`
      : summarizeAnswer(turn.answer, turnLimit);
    if (point) lines.push(`   → ${point}`);
  });
  lines.push(
    "",
    `全 ${s.turns.length} ターンの回答全文・グラフ・トポロジ図はダッシュボードでご確認ください${
      opts.sourceUrl ? `: ${opts.sourceUrl}` : ""
    }`,
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

  const fullLimit = 400;
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
