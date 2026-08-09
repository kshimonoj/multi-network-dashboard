// Coach View(65)— 根拠へのリンク。
//
// **ネタバレの制御がソクラテス式との唯一の正面衝突**(64_findings.md §5-3(c))。
// 根拠リンクを開くと rootCause / action が読めてしまう。これは設計上の矛盾なので
// **時間軸で分ける**(先に考えさせ、後で確かめさせる):
//
//   hintLevel 0〜2 … 「元になった記録があるよ(N 件)」とだけ見せる。タイトルも畳んだまま
//   hintLevel 3    … 全部展開できる。**元記録を読ませることが次の学習**になる
//
// 根拠の取得は 2 経路の併用(§5-3(a)):
//   1. モデルが [SRC:...] で挙げたもの(= 実際に使ったのはどれか)
//   2. サーバが渡した素材一覧(= 根拠の上限。取りこぼしを防ぐ)
// 1 だけだと取りこぼし、2 だけだと「実際に使ったのはどれか」が分からない。両方出す。

import { useState } from "react";
import type { TFunc } from "../../../src/i18n";
import type { MaterialKind, MaterialRef } from "./types";

interface Props {
  t: TFunc;
  materials: MaterialRef[];
  citedIds: string[];
  /** 展開できるか。hintLevel が 3(または解説済み)になって初めて true。 */
  unlocked: boolean;
  onOpenKnowledge: (id: string) => void;
  onOpenHistory: (runId: string) => void;
  onOpenRule: (ruleId: string) => void;
}

const KIND_ICON: Record<MaterialKind, string> = { knowledge: "📘", history: "🔎", live: "📡", rule: "📐" };

export function Evidence({ t, materials, citedIds, unlocked, onOpenKnowledge, onOpenHistory, onOpenRule }: Props) {
  const [open, setOpen] = useState(false);
  if (materials.length === 0) return null;

  const cited = new Set(citedIds);
  // モデルが実際に挙げたものを先に出す(「どれを使ったか」が一目で分かるように)。
  const sorted = [...materials].sort((a, b) => {
    const ca = cited.has(`${a.kind}:${a.id}`) ? 0 : 1;
    const cb = cited.has(`${b.kind}:${b.id}`) ? 0 : 1;
    return ca - cb;
  });

  if (!unlocked) {
    // まだ考えている最中。「根拠はあるが、今は見せない」ことだけを伝える。
    return (
      <div className="co-evidence co-evidence-locked">
        <span aria-hidden>🔒</span> {t("coach.evidence.locked", { n: materials.length })}
      </div>
    );
  }

  return (
    <div className="co-evidence">
      <button
        className="co-evidence-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden>📎</span> {t("coach.evidence.title", { n: materials.length })}
        <span className="co-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <ul className="co-evidence-list">
          {sorted.map((m) => (
            <li key={`${m.kind}:${m.id}`} className="co-evidence-item">
              <div className="co-evidence-head">
                <span className={`co-layer co-layer-${m.kind}`}>
                  <span aria-hidden>{KIND_ICON[m.kind]}</span> {t(`coach.layer.${m.kind}`)}
                </span>
                {cited.has(`${m.kind}:${m.id}`) && (
                  <span className="co-cited" title={t("coach.evidence.citedTitle")}>
                    {t("coach.evidence.cited")}
                  </span>
                )}
              </div>
              {/* 素材のタイトルは原文のまま出す(実行時の記録なので翻訳しない)。 */}
              <div className="co-evidence-title">{m.title}</div>
              <div className="co-evidence-actions">
                {m.kind === "knowledge" && (
                  <button className="co-link" onClick={() => onOpenKnowledge(m.id)}>
                    {t("coach.evidence.openKnowledge")} →
                  </button>
                )}
                {m.kind === "history" && m.meta.runId && (
                  <button className="co-link" onClick={() => onOpenHistory(m.meta.runId as string)}>
                    {t("coach.evidence.openHistory")} →
                  </button>
                )}
                {m.kind === "rule" && (
                  <button className="co-link" onClick={() => onOpenRule(m.id)}>
                    {t("coach.evidence.openRule", { id: m.id })} →
                  </button>
                )}
                {/* ライブ素材(68 番)は元記録が無い(その場で取った事実)ので、
                    リンクの代わりに「何を叩いて確かめたか」を出す。ツール名は原文のまま。 */}
                {m.kind === "live" && (m.meta.tools ?? []).length > 0 && (
                  <span className="co-evidence-tools">
                    {t("coach.evidence.liveTools", { tools: (m.meta.tools ?? []).join(", ") })}
                  </span>
                )}
                {/* ナレッジ素材でも元調査があれば辿れる。 */}
                {m.kind === "knowledge" && m.meta.runId && (
                  <button className="co-link" onClick={() => onOpenHistory(m.meta.runId as string)}>
                    {t("coach.evidence.openHistory")} →
                  </button>
                )}
                {/* ルールの出典は外部ドキュメント。翻訳しない(49 §4-4)。 */}
                {m.kind === "rule" &&
                  (m.meta.references ?? []).map((r) => (
                    <a
                      key={r.url}
                      className="co-link co-link-ext"
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.title} ↗
                    </a>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
