// Corstack シェル依存のローカル差し替え(1ファイル)。
//
// 移植元 view/NetworkInvestigation.tsx は Corstack 本体の 2 モジュールを参照していた:
//   - ../../../src/lib/types          … PluginEntry 型(型のみ)
//   - ../../../src/lib/topbarModel    … useSetTopbarModel / topbarModelLabel
//
// 本アプリは単一プラグインの独立アプリで、「複数プラグインを横断するトップバー」という前提が
// 無い。よって Corstack の Context 実装は持ち込まず、ここに最小の互換 API を置く。
// 本ファイルは実質 no-op スタブだが、シェル側で実際に描画したい場合に備えて Context だけは
// 生かしてあり、main.tsx がその値をタイトル行の右端へ出している。

import { createContext, useContext } from "react";

// ---- PluginEntry(Corstack src/lib/types.ts と同じ形) ----
// 本アプリではプラグイン一覧が無いので固定値 1 件を main.tsx から渡すだけ。
export interface PluginEntry {
  id: string;
  name: string;
  sub?: string;
  icon?: string;
  order: number;
}

// ---- topbarModel(Corstack src/lib/topbarModel.tsx の no-op スタブ) ----
export interface TopbarModel {
  label: string;
  fixed?: boolean;
}

export type SetTopbarModel = (model: TopbarModel | null) => void;

// 既定値は何もしない関数。Provider を挿さなければ完全な no-op として振る舞う。
export const TopbarModelContext = createContext<SetTopbarModel>(() => {});

export function useSetTopbarModel(): SetTopbarModel {
  return useContext(TopbarModelContext);
}

// モデル値をトップバー表示用の文字列に整える(Corstack 版と同じ挙動)。
export function topbarModelLabel(model: string | null | undefined): string {
  const v = (model ?? "").trim();
  return v === "" ? "(旧・未指定)" : v;
}

// ---- 調査キュー(15番) ----
// Global Overview / Event Feed 側の「調査する」ボタンから、ネットワーク調査タブへ
// 事前入力クエリを渡すための共有state。main.tsx がローカル state として保持し、
// NetworkInvestigation が消費(反映後にクリア)する。自動実行はしない(文面を用意するだけ)。
export interface InvestigationRequest {
  /** 入力欄にそのまま入れるクエリ文(サイト名・重要度・カテゴリ・時刻・本文を含む) */
  query: string;
  /** サイト名が特定できる場合のみ。NetworkInvestigation 側のサイト一覧と突き合わせて選択する */
  site: string | null;
}

// ---- 履歴ジャンプ(18番) ----
// Webhook ログの「自動事前調査あり」の行から、その調査が実際に実行された履歴(セッション/スレッド)
// そのものへ直接ジャンプするための共有state。pendingInvestigationQuery(新しいクエリの事前入力)とは
// 別物で、こちらは「既に実行済みの結果を開く」ためだけに使う(クエリ文は組み立てない)。
// 値は対象実行の runId(= HistoryRecord.id。webhook-feed/enrich.ts が記録時に一致させている)。
// main.tsx がローカル state として保持し、NetworkInvestigation が消費(反映後にクリア)する。
export type PendingHistoryFocus = string;
