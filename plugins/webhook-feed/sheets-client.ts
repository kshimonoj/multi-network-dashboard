// Webhook ログ(17 Task 1)— Google Sheets 読み取り基盤。
//
// 認証: サービスアカウント(非公開)。ユーザーが Google Cloud で発行した JSON 鍵を
//       secrets/ に置き、対象スプレッドシートをそのサービスアカウントのメールアドレスに
//       「閲覧者」で共有しておく。OAuth 同意画面もリダイレクト URI も要らない。
//       スコープは spreadsheets.readonly のみ(書き込み権限は要求しない)。
//
// 差分取得: シートごとに「前回読んだ最終行番号」を持ち、次回は `A{lastRow+1}:Z` だけ読む。
//       追記専用のログシートなので、行番号がそのまま安定した進捗マーカーになる。
//       シートがクリア/縮小された場合に備え、同じ batchGet で「前回の最終行がまだ存在するか」を
//       確認するアンカー範囲も一緒に取り、消えていたら全件読み直しへフォールバックする。
//
// グリッド上限(84):
//       Sheets API は開始行がシートのグリッド行数(gridProperties.rowCount)を超える範囲を
//       空配列ではなく 400 "exceeds grid limits" で返す。Apps Script の appendRow は
//       グリッドをちょうど 1 行ずつ伸ばすので、既定の 1000 行を使い切ったシートでは
//       「全行を読み終わった = 次に読む行がグリッドの外」になり、新規行が来るまで失敗し続ける。
//       そこで readMeta でグリッド行数も取り、開始行がその外なら範囲を投げずに「新規なし」にする。
//
// シート間の独立(84):
//       batchGet は 1 範囲でも不正だとリクエスト全体が失敗する。以前は 3 シートを 1 本に
//       まとめていたため、1 シートの失敗で残りも読めず、全シートに同じエラーが表示されていた。
//       いまはシートごとに batchGet を分け(= 1 巡 HTTP 3 本)、失敗はそのシートの error に閉じ込める。
//
// 値の読み方(実測で決めた。instructions/17_findings.md 参照):
//       valueRenderOption は UNFORMATTED_VALUE を使う。FORMATTED_VALUE だと 17 桁の
//       New Central サイト ID が表示丸め("8.49486E+16")になり、桁が失われるため。
//       そのぶん日時はシリアル値で返るので、スプレッドシートのタイムゾーンで ISO へ直す。

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdir, access } from "node:fs/promises";
import { google, type sheets_v4 } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/** サービスアカウント鍵の既定パス(タスク指定)。無ければ secrets/ 内の *.json を拾う。 */
const DEFAULT_KEY_FILE = path.join(ROOT, "secrets", "sheets-service-account.json");
const SECRETS_DIR = process.env.WEBHOOK_LOG_SECRETS_DIR || path.join(ROOT, "secrets");

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];

export class SheetsConfigError extends Error {}

/**
 * 使用するサービスアカウント鍵のパスを決める。
 *  1. WEBHOOK_LOG_SA_KEY_FILE(明示指定)
 *  2. secrets/sheets-service-account.json(タスクが想定するパス)
 *  3. secrets/ 直下の *.json を 1 件(Google Cloud がダウンロードさせる既定のファイル名は
 *     `<project>-<keyid>.json` なので、リネームせず置いた場合をここで拾う)
 */
export async function resolveKeyFile(): Promise<string> {
  const explicit = (process.env.WEBHOOK_LOG_SA_KEY_FILE || "").trim();
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.resolve(ROOT, explicit);
    try {
      await access(p);
      return p;
    } catch {
      throw new SheetsConfigError(`WEBHOOK_LOG_SA_KEY_FILE で指定された鍵が読めません: ${p}`);
    }
  }
  try {
    await access(DEFAULT_KEY_FILE);
    return DEFAULT_KEY_FILE;
  } catch {
    /* 既定名でなければ secrets/ を走査する */
  }
  let names: string[];
  try {
    names = await readdir(SECRETS_DIR);
  } catch {
    throw new SheetsConfigError(
      `サービスアカウント鍵が見つかりません(${SECRETS_DIR} が存在しません)。` +
        `secrets/sheets-service-account.json を配置するか WEBHOOK_LOG_SA_KEY_FILE を設定してください。`,
    );
  }
  const jsons = names.filter((n) => n.endsWith(".json")).sort();
  if (jsons.length === 0) {
    throw new SheetsConfigError(
      `サービスアカウント鍵が見つかりません(${SECRETS_DIR} に *.json がありません)。`,
    );
  }
  return path.join(SECRETS_DIR, jsons[0]);
}

/** 対象スプレッドシート ID(.env の WEBHOOK_LOG_SPREADSHEET_ID)。 */
export function spreadsheetId(): string {
  const id = (process.env.WEBHOOK_LOG_SPREADSHEET_ID || "").trim();
  if (!id) {
    throw new SheetsConfigError(
      "WEBHOOK_LOG_SPREADSHEET_ID が設定されていません(.env / docker-compose の environment に、" +
        "Webhook ログのスプレッドシート ID を設定してください)。",
    );
  }
  return id;
}

let clientPromise: Promise<sheets_v4.Sheets> | null = null;
let clientEmail: string | null = null;

/** 認証済み Sheets クライアント(プロセス内で使い回す。アクセストークンは googleapis が更新する)。 */
export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const keyFile = await resolveKeyFile();
      const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
      const c = await auth.getClient();
      // 共有漏れ("The caller does not have permission")の切り分け用に、
      // どのサービスアカウントで読んでいるかだけログに出す(鍵の中身は出さない)。
      clientEmail = (c as { email?: string }).email ?? null;
      console.log(
        `[webhook-feed] Google Sheets 認証: keyFile=${path.relative(ROOT, keyFile)}` +
          `${clientEmail ? ` account=${clientEmail}` : ""}`,
      );
      return google.sheets({ version: "v4", auth });
    })().catch((err) => {
      clientPromise = null; // 次回やり直せるようにする
      throw err;
    });
  }
  return clientPromise;
}

export function getServiceAccountEmail(): string | null {
  return clientEmail;
}

// ---- 日時の変換 ----

/** 指定インスタントにおける IANA タイムゾーンの UTC オフセット(ミリ秒)。 */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  return Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second")) - instantMs;
}

/** Sheets のシリアル値(1899-12-30 起点・シートのタイムゾーンでの壁時計)を ISO 文字列にする。 */
export function serialToIso(serial: number, timeZone: string): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const wallAsUtcMs = Math.round((serial - 25569) * 86_400_000);
  // 壁時計を一旦 UTC とみなし、そのタイムゾーンのオフセットを引いて実インスタントを得る。
  // DST 境界でオフセットが変わりうるので 1 度だけ補正し直す(Asia/Tokyo では 1 回目で確定)。
  let instant = wallAsUtcMs - tzOffsetMs(wallAsUtcMs, timeZone);
  instant = wallAsUtcMs - tzOffsetMs(instant, timeZone);
  const d = new Date(instant);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * セル値を ISO 文字列にする。
 * シリアル値(数値)なら serialToIso、文字列ならそのまま Date.parse を試す。
 */
export function cellToIso(v: unknown, timeZone: string): string | null {
  if (typeof v === "number") return serialToIso(v, timeZone);
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(s) && n > 20000 && n < 100000) {
    return serialToIso(n, timeZone);
  }
  // "2026-07-26 10:40:30"(シートのローカル時刻)形式にも一応対応する。
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
    let instant = wall - tzOffsetMs(wall, timeZone);
    instant = wall - tzOffsetMs(instant, timeZone);
    return new Date(instant).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * セル値を文字列にする。
 * 数値は「見た目の丸め」を避けたいので、整数はそのまま桁を保って出す
 * (17 桁のサイト ID は double の精度限界を超えており、シートの時点で既に丸まっている。
 *  ここでは少なくとも指数表記にはしない)。
 */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(0);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

// ---- 差分読み取り ----

export interface SheetReadResult {
  sheet: string;
  /** ヘッダ行(1 行目)。取得できなければ空配列 */
  headers: string[];
  /** 新規行。rowIndex はスプレッドシート上の行番号(1 始まり) */
  rows: Array<{ rowIndex: number; values: unknown[] }>;
  /** このシートの新しい lastRow(= 読み終わった最終行番号) */
  lastRow: number;
  /** 前回の lastRow が消えていたため全件読み直したか */
  resynced: boolean;
  error: string | null;
}

export interface SpreadsheetRead {
  title: string;
  timeZone: string;
  sheets: SheetReadResult[];
  /** この取得で出した HTTP リクエスト数 */
  requests: number;
}

/** シートのメタ(タイトル・タイムゾーン・存在するシート名・グリッド行数)を取得する。 */
export async function readMeta(): Promise<{
  title: string;
  timeZone: string;
  sheetNames: string[];
  /** シート名 → グリッド行数(空行を含むシートの物理的な行数) */
  rowCounts: Record<string, number>;
}> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: "properties(title,timeZone),sheets.properties(title,gridProperties.rowCount)",
  });
  const props = res.data.properties ?? {};
  const rowCounts: Record<string, number> = {};
  for (const s of res.data.sheets ?? []) {
    const title = s.properties?.title;
    const n = s.properties?.gridProperties?.rowCount;
    if (title && typeof n === "number") rowCounts[title] = n;
  }
  return {
    title: props.title ?? "(無題)",
    timeZone: props.timeZone || "Asia/Tokyo",
    sheetNames: (res.data.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean),
    rowCounts,
  };
}

/**
 * 1 シートの新規行を読む。失敗は throw せず error に入れて返す(他シートを巻き込まない)。
 * @param rowCount グリッド行数。分からなければ undefined(ガードせずに読む)
 */
async function readSheetNewRows(
  client: sheets_v4.Sheets,
  id: string,
  name: string,
  lastRow: number | undefined,
  rowCount: number | undefined,
): Promise<{ result: SheetReadResult; requests: number }> {
  const last = Math.max(1, Math.floor(lastRow ?? 1));
  let requests = 0;
  try {
    // 前回の最終行がグリッドの外 = シートが縮小された(アンカーを投げると 400 になるので先に判定)。
    const shrunk = rowCount !== undefined && last > rowCount;
    // 次に読む行がグリッドの外 = 読み終わっていて新規行はない。
    const caughtUp = rowCount !== undefined && last + 1 > rowCount;

    // 1 シートにつき: ヘッダ / アンカー(前回最終行が生きているか) / 新規行。
    const ranges: string[] = [`${name}!A1:Z1`];
    const anchor = !shrunk && last > 1 ? ranges.push(`${name}!A${last}:A${last}`) - 1 : null;
    const data = !shrunk && !caughtUp ? ranges.push(`${name}!A${last + 1}:Z`) - 1 : null;

    const res = await client.spreadsheets.values.batchGet({
      spreadsheetId: id,
      ranges,
      valueRenderOption: "UNFORMATTED_VALUE",
      majorDimension: "ROWS",
    });
    requests += 1;
    const got = res.data.valueRanges ?? [];
    const headers = (got[0]?.values?.[0] ?? []).map((v) => cellToString(v).trim());
    const anchorAlive = shrunk ? false : anchor === null ? true : (got[anchor]?.values?.length ?? 0) > 0;

    if (anchorAlive) {
      const values = data === null ? [] : (got[data]?.values ?? []);
      const rows = values.map((v, i) => ({ rowIndex: last + 1 + i, values: v }));
      return {
        result: { sheet: name, headers, rows, lastRow: last + rows.length, resynced: false, error: null },
        requests,
      };
    }

    // シートがクリア/縮小された。ヘッダの次の行から全部読み直す。
    // rowCount が 1(ヘッダのみ)なら A2 はグリッドの外なので、読まずに空とする。
    let values: unknown[][] = [];
    if (rowCount === undefined || rowCount >= 2) {
      const re = await client.spreadsheets.values.get({
        spreadsheetId: id,
        range: `${name}!A2:Z`,
        valueRenderOption: "UNFORMATTED_VALUE",
        majorDimension: "ROWS",
      });
      requests += 1;
      values = re.data.values ?? [];
    }
    const rows = values.map((v, j) => ({ rowIndex: 2 + j, values: v }));
    console.warn(`[webhook-feed] ${name} が縮小(またはクリア)されたため全件読み直しました(${rows.length} 行)`);
    return {
      result: { sheet: name, headers, rows, lastRow: 1 + rows.length, resynced: true, error: null },
      requests,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: { sheet: name, headers: [], rows: [], lastRow: last, resynced: false, error: msg },
      requests: requests + 1,
    };
  }
}

/**
 * 各シートの新規行を読む。シートごとに独立したリクエストにし、並行して投げる。
 * 1 シートの失敗はそのシートの error に入り、他のシートの結果には影響しない。
 * @param lastRows シート名 → 前回読んだ最終行番号(未読は 1 = ヘッダのみ)
 * @param rowCounts シート名 → グリッド行数(readMeta の値)。無いシートはガードせずに読む
 */
export async function readNewRows(
  sheetNames: string[],
  lastRows: Record<string, number>,
  rowCounts: Record<string, number> = {},
): Promise<{ sheets: SheetReadResult[]; requests: number }> {
  const client = await getSheetsClient();
  const id = spreadsheetId();
  const results = await Promise.all(
    sheetNames.map((name) => readSheetNewRows(client, id, name, lastRows[name], rowCounts[name])),
  );
  return {
    sheets: results.map((r) => r.result),
    requests: results.reduce((n, r) => n + r.requests, 0),
  };
}
