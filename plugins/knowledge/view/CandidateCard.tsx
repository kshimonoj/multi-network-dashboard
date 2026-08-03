// ナレッジタブ(46 Task 3 / Task 4)— 未承認候補のカード。
//
// 承認の手間を最小化するのがこの画面の眼目なので、
//   ・カード 1 枚に「タイトル・症状・根本原因・対処法」が全部載っている
//   ・「承認」ボタン 1 クリックで完了する(入力は一切必須にしない)
//   ・直したいときだけ「編集して承認」で編集欄を開く
// という順序にしてある。却下も 1 クリック(消さずに却下済みとして残る)。
//
// 類似する承認済みエントリがある候補(Task 2)は、新規追加ではなく **マージ提案** として出す。
// 「マージする(既存を更新)」か「別エントリとして承認する」かを人が選ぶ。

import { useState } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime } from "../../../src/i18n";
import type { PendingHistoryFocus } from "../../../src/shell";
import {
  EntryBadges,
  EntryEditor,
  EntryFields,
  EntryMeta,
  EntrySources,
  LangNote,
  toDraft,
  toPatch,
  type Draft,
} from "./EntryBody";
import type { EntryPatch, KnowledgeEntry } from "./types";

export function CandidateCard({
  entry,
  selected,
  onToggleSelect,
  approvedById,
  busy,
  onApprove,
  onReject,
  onMerge,
  onOpenHistoryFocus,
}: {
  entry: KnowledgeEntry;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** 類似候補(similar)の相手を引き当てるための承認済みエントリ。 */
  approvedById: Map<string, KnowledgeEntry>;
  busy: boolean;
  onApprove: (id: string, patch?: EntryPatch) => void;
  onReject: (id: string) => void;
  onMerge: (id: string, targetId: string, patch?: EntryPatch) => void;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(entry));
  const [openSimilar, setOpenSimilar] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(toDraft(entry));
    setEditing(true);
  };

  return (
    <div className={`go-panel kb-card${selected ? " kb-card-selected" : ""}`}>
      <div className="kb-card-head">
        <label className="kb-check" title={t("knowledge.bulk.selectTitle")}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(entry.id)} />
        </label>
        <span className="kb-card-title">{editing ? t("knowledge.actions.editing") : entry.title}</span>
        <EntryBadges entry={entry} />
        <span className="go-note kb-card-at">
          {t("knowledge.meta.created", { at: formatDateTime(entry.createdAt, lang) })}
        </span>
      </div>

      <LangNote entry={entry} />

      {editing ? (
        <EntryEditor draft={draft} onChange={setDraft} />
      ) : (
        <>
          <EntryFields entry={entry} />
          <EntryMeta entry={entry} />
        </>
      )}

      <EntrySources entry={entry} onOpenHistoryFocus={onOpenHistoryFocus} />

      {/* ---- Task 2: マージ提案 ---- */}
      {entry.similar.length > 0 && !editing && (
        <div className="kb-similar">
          <div className="kb-similar-head">
            <span className="kb-similar-mark" aria-hidden>
              ⚠
            </span>
            <span className="kb-similar-title">{t("knowledge.similar.title")}</span>
          </div>
          {entry.similar.map((s) => {
            const target = approvedById.get(s.id) ?? null;
            const open = openSimilar === s.id;
            return (
              <div className="kb-similar-item" key={s.id}>
                <div className="kb-similar-row">
                  <button
                    className="kb-similar-toggle"
                    onClick={() => setOpenSimilar(open ? null : s.id)}
                    aria-expanded={open}
                  >
                    <span className={`kb-caret${open ? " kb-caret-open" : ""}`} aria-hidden>
                      ▸
                    </span>
                    {target?.title ?? s.title}
                  </button>
                  <span className="go-note kb-similar-score">
                    {t("knowledge.similar.score", { score: s.score.toFixed(2) })}
                  </span>
                  <button
                    className="kb-btn kb-btn-merge"
                    disabled={busy || !target}
                    onClick={() => onMerge(entry.id, s.id)}
                    title={t("knowledge.similar.mergeTitle")}
                  >
                    {t("knowledge.similar.merge")}
                  </button>
                </div>
                {open && target && (
                  <div className="kb-similar-body">
                    <EntryFields entry={target} />
                    <EntryMeta entry={target} />
                  </div>
                )}
                {open && !target && <div className="go-note">{t("knowledge.similar.missing")}</div>}
              </div>
            );
          })}
          <div className="go-note kb-similar-note">{t("knowledge.similar.keepSeparateNote")}</div>
        </div>
      )}

      {/* ---- 承認フロー ---- */}
      <div className="kb-actions">
        {editing ? (
          <>
            <button
              className="kb-btn kb-btn-approve"
              disabled={busy}
              onClick={() => {
                onApprove(entry.id, toPatch(draft));
                setEditing(false);
              }}
            >
              {t("knowledge.actions.saveAndApprove")}
            </button>
            <button className="kb-btn" disabled={busy} onClick={() => setEditing(false)}>
              {t("knowledge.actions.cancel")}
            </button>
          </>
        ) : (
          <>
            <button className="kb-btn kb-btn-approve" disabled={busy} onClick={() => onApprove(entry.id)}>
              {t("knowledge.actions.approve")}
            </button>
            <button className="kb-btn" disabled={busy} onClick={startEdit}>
              {t("knowledge.actions.editApprove")}
            </button>
            <button className="kb-btn kb-btn-reject" disabled={busy} onClick={() => onReject(entry.id)}>
              {t("knowledge.actions.reject")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
