// ナレッジタブ(46 Task 4)。
//
// 画面の骨格:
//   ┌ 見出し + 抽出の現況(折りたたみ)
//   ├ 区分タブ(未承認 / 承認済み / 却下・統合済み)
//   ├ 未承認: 候補カード(承認 / 編集して承認 / 却下、チェックしてまとめて承認)
//   ├ 承認済み: 検索 + タグ絞り込み + 一覧(編集 / 調査結果を見る)
//   └ 却下・統合済み: 消さずに残したもの(承認で復活できる)
//
// 46 は「抽出 → 承認 → 蓄積」まで。47 で「次の調査プロンプトへの注入」が入ったので、
// 承認済みカードには注入実績(参照回数 / 最終参照日時 / 未参照)が出る。
// 実際にどの調査へ注入されたかは、ネットワーク調査タブの実行ログ・ターン表示で見える。
//
// 本文(タイトル・症状・根本原因・対処法)は生成時の言語のまま出す。ラベルだけが表示言語に追従する。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../../../src/i18n/LanguageContext";
import { formatDateTime } from "../../../src/i18n";
import type { PendingHistoryFocus } from "../../../src/shell";
import {
  applyPendingDuplicates,
  approveEntry,
  approveMany,
  fetchEntries,
  fetchStatus,
  mergeEntry,
  rejectEntry,
  scanPendingDuplicates,
  updateEntry,
} from "./api";
import { CandidateCard } from "./CandidateCard";
import {
  EntryBadges,
  EntryEditor,
  EntryFields,
  EntryMeta,
  EntryRefs,
  EntrySources,
  LangNote,
  toDraft,
  toPatch,
  type Draft,
} from "./EntryBody";
import type {
  DedupeScanResponse,
  EntryPatch,
  KnowledgeEntry,
  KnowledgeStatusResponse,
} from "./types";
import "./styles.css";

type Section = "pending" | "approved" | "archive";

const SECTIONS: Section[] = ["pending", "approved", "archive"];

// 承認済み一覧の並び順(47 Task 3)。
//   approved  … 承認が新しい順(46 までの既定)
//   refs      … 参照回数の多い順(よく効いている知見)
//   stale     … 未参照 → 最終参照が古い順(使われていない知見の棚卸し)
type SortKey = "approved" | "refs" | "stale";

const SORTS: SortKey[] = ["approved", "refs", "stale"];

/** タブを開いている間だけ、新しく生成された候補を拾いに行く間隔。 */
const POLL_MS = 20_000;

/** 承認済みエントリ 1 件。編集は押した人だけが開く(既定は読むだけ)。 */
function ApprovedCard({
  entry,
  busy,
  onSave,
  onReject,
  onTag,
  activeTag,
  onOpenHistoryFocus,
  highlighted,
  onHighlightDone,
}: {
  entry: KnowledgeEntry;
  busy: boolean;
  onSave: (id: string, patch: EntryPatch) => void;
  onReject: (id: string) => void;
  onTag: (tag: string) => void;
  activeTag: string | null;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
  /** Coach の根拠リンク(65)から飛んできた対象か。 */
  highlighted?: boolean;
  onHighlightDone?: () => void;
}) {
  const { lang, t } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(entry));
  const cardRef = useRef<HTMLDivElement | null>(null);

  // 65: 特定エントリへの deep-link。ベストプラクティスの RuleReference と同じ作法
  // (scrollIntoView + 2 秒だけハイライトして自分で消える)。
  useEffect(() => {
    if (!highlighted) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => onHighlightDone?.(), 2000);
    return () => window.clearTimeout(timer);
  }, [highlighted, onHighlightDone]);

  return (
    <div
      ref={cardRef}
      id={`kb-entry-${entry.id}`}
      className={`go-panel kb-card${highlighted ? " kb-card-highlight" : ""}`}
    >
      <div className="kb-card-head">
        <span className="kb-card-title">{editing ? t("knowledge.actions.editing") : entry.title}</span>
        <EntryBadges entry={entry} />
        <span className="go-note kb-card-at">
          {t("knowledge.meta.approved", { at: formatDateTime(entry.approvedAt ?? entry.updatedAt, lang) })}
          {entry.mergedFrom.length > 0
            ? ` / ${t("knowledge.meta.merged", { n: entry.mergedFrom.length })}`
            : ""}
        </span>
        {/* 調査プロンプトへの注入実績(47)。未参照はここで一目で分かる。 */}
        <EntryRefs entry={entry} />
      </div>
      <LangNote entry={entry} />
      {editing ? (
        <EntryEditor draft={draft} onChange={setDraft} />
      ) : (
        <>
          <EntryFields entry={entry} />
          <EntryMeta entry={entry} onTag={onTag} activeTag={activeTag} />
        </>
      )}
      <EntrySources entry={entry} onOpenHistoryFocus={onOpenHistoryFocus} />
      <div className="kb-actions">
        {editing ? (
          <>
            <button
              className="kb-btn kb-btn-approve"
              disabled={busy}
              onClick={() => {
                onSave(entry.id, toPatch(draft));
                setEditing(false);
              }}
            >
              {t("knowledge.actions.save")}
            </button>
            <button className="kb-btn" disabled={busy} onClick={() => setEditing(false)}>
              {t("knowledge.actions.cancel")}
            </button>
          </>
        ) : (
          <>
            <button
              className="kb-btn"
              disabled={busy}
              onClick={() => {
                setDraft(toDraft(entry));
                setEditing(true);
              }}
            >
              {t("knowledge.actions.edit")}
            </button>
            <button className="kb-btn kb-btn-reject" disabled={busy} onClick={() => onReject(entry.id)}>
              {t("knowledge.actions.retire")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 却下・統合済みの 1 行(内容は畳んでおき、必要なときだけ開く)。 */
function ArchiveRow({
  entry,
  byId,
  busy,
  onApprove,
  onOpenHistoryFocus,
}: {
  entry: KnowledgeEntry;
  byId: Map<string, KnowledgeEntry>;
  busy: boolean;
  onApprove: (id: string) => void;
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
}) {
  const { lang, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const target = entry.mergedInto ? byId.get(entry.mergedInto) : null;

  return (
    <div className="kb-arch">
      <div className="kb-arch-row">
        <button className="kb-similar-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`kb-caret${open ? " kb-caret-open" : ""}`} aria-hidden>
            ▸
          </span>
          {entry.title}
        </button>
        <span className={`go-tag kb-status-${entry.status}`}>{t(`knowledge.status.${entry.status}`)}</span>
        <span className="go-note kb-card-at">
          {entry.status === "merged" && target
            ? t("knowledge.archive.mergedInto", { title: target.title })
            : t("knowledge.meta.rejected", { at: formatDateTime(entry.rejectedAt ?? entry.updatedAt, lang) })}
        </span>
        <button className="kb-btn" disabled={busy} onClick={() => onApprove(entry.id)}>
          {t("knowledge.actions.restore")}
        </button>
      </div>
      {open && (
        <div className="kb-arch-body">
          <EntryFields entry={entry} />
          <EntryMeta entry={entry} />
          <EntrySources entry={entry} onOpenHistoryFocus={onOpenHistoryFocus} />
        </div>
      )}
    </div>
  );
}

export function Knowledge({
  active,
  onOpenHistoryFocus,
  onPendingCount,
  pendingEntryFocus,
  onConsumePendingEntryFocus,
}: {
  active: boolean;
  /** 出典の調査スレッドへ直接ジャンプする(18/19 番の pendingHistoryFocus と同じ経路)。 */
  onOpenHistoryFocus?: (runId: PendingHistoryFocus) => void;
  /** タブ名の横に出す未承認件数バッジの更新。 */
  onPendingCount?: (n: number) => void;
  /**
   * Coach タブの根拠リンク(65)から渡される「開きたい承認済みエントリの id」。
   * 受け取ったら承認済みセクションへ切り替え、検索・タグ絞り込みを解除してから
   * 対象カードへスクロールしてハイライトする(絞り込みが残っていると対象が
   * 一覧に居らず、リンクを押しても何も起きないように見える)。
   */
  pendingEntryFocus?: string | null;
  onConsumePendingEntryFocus?: () => void;
}) {
  const { lang, t } = useLanguage();
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [status, setStatus] = useState<KnowledgeStatusResponse | null>(null);
  const [section, setSection] = useState<Section>("pending");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("approved");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  /**
   * 71: 承認済みと同じ知見の未承認候補。「検出」を押した結果を保持する。
   * null = まだ検出していない。検出しただけでは何も変わらず、統合を押して初めて反映する。
   */
  const [dupes, setDupes] = useState<DedupeScanResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  /** Coach から飛んできたエントリ(65)。2 秒だけハイライトして自分で消える。 */
  const [highlightEntryId, setHighlightEntryId] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, st] = await Promise.all([fetchEntries(), fetchStatus()]);
      if (!mounted.current) return;
      setEntries(list.entries);
      setStatus(st);
      setError(null);
      onPendingCount?.(list.counts.pending);
      // 承認・却下で消えた候補が選択に残らないようにする。
      setSelected((prev) => {
        const alive = new Set(list.entries.filter((e) => e.status === "pending").map((e) => e.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [onPendingCount]);

  // タブを開いている間だけ読み込む/追従する(裏で回り続けない)。
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const pending = useMemo(() => entries.filter((e) => e.status === "pending"), [entries]);
  const approved = useMemo(() => entries.filter((e) => e.status === "approved"), [entries]);
  const archive = useMemo(
    () => entries.filter((e) => e.status === "rejected" || e.status === "merged"),
    [entries],
  );
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const approvedById = useMemo(() => new Map(approved.map((e) => [e.id, e])), [approved]);

  // Coach の根拠リンク(65)から飛んできたときの受け口。
  // 他タブの pendingXxx と同じ「マウント時 / 更新時に消費してクリアする」形にする。
  useEffect(() => {
    if (!pendingEntryFocus) return;
    setSection("approved");
    setQ("");
    setTag(null);
    setHighlightEntryId(pendingEntryFocus);
    onConsumePendingEntryFocus?.();
  }, [pendingEntryFocus, onConsumePendingEntryFocus]);

  /** 承認済みのタグ(件数の多い順)。絞り込みチップに使う。 */
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of approved) for (const tg of e.tags) map.set(tg, (map.get(tg) ?? 0) + 1);
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [approved]);

  const filteredApproved = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/[\s　]+/).filter(Boolean);
    const list = approved.filter((e) => {
      if (tag && !e.tags.includes(tag)) return false;
      if (terms.length === 0) return true;
      const hay = [e.title, e.symptom, e.rootCause, e.action, e.site ?? "", e.device ?? "", ...e.tags]
        .join("\n")
        .toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
    // 並べ替え(47)。サーバは常に新しい順で返すので、ここで詰め替える。
    if (sort === "refs") {
      return list.slice().sort((a, b) => {
        const d = (b.refCount ?? 0) - (a.refCount ?? 0);
        if (d !== 0) return d;
        return (a.approvedAt ?? "") < (b.approvedAt ?? "") ? 1 : -1;
      });
    }
    if (sort === "stale") {
      // 未参照(null)を先頭に、次に最終参照が古い順。棚卸しの目線に合わせる。
      return list.slice().sort((a, b) => {
        const av = a.lastReferencedAt ?? "";
        const bv = b.lastReferencedAt ?? "";
        if (av === bv) return (a.approvedAt ?? "") < (b.approvedAt ?? "") ? -1 : 1;
        return av < bv ? -1 : 1;
      });
    }
    return list;
  }, [approved, q, tag, sort]);

  // ---- 操作(いずれも完了後に一覧を取り直す。楽観的更新は持たない)----

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        setError(null);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setBusy(false);
        await load();
      }
    },
    [load],
  );

  const onApprove = useCallback(
    (id: string, patch?: EntryPatch) => void run(() => approveEntry(id, patch)),
    [run],
  );
  const onReject = useCallback((id: string) => void run(() => rejectEntry(id)), [run]);
  const onMerge = useCallback(
    (id: string, targetId: string, patch?: EntryPatch) => void run(() => mergeEntry(id, targetId, patch)),
    [run],
  );
  const onSave = useCallback((id: string, patch: EntryPatch) => void run(() => updateEntry(id, patch)), [run]);
  const onBulkApprove = useCallback(() => {
    const ids = [...selected];
    if (ids.length === 0) return;
    void run(async () => {
      await approveMany(ids);
      setSelected(new Set());
    });
  }, [run, selected]);

  // ---- 71: 承認済みと重複した未承認候補の整理 ----
  //
  // 検出は LLM 判定を挟むので候補の件数によっては数十秒かかる。走っている間は
  // 一覧の自動再読込(POLL_MS)で結果が消えないよう、dupes は load() では触らない。
  const onScanDupes = useCallback(async () => {
    setScanning(true);
    try {
      setDupes(await scanPendingDuplicates(lang));
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setScanning(false);
    }
  }, [lang]);

  const onApplyDupes = useCallback(() => {
    const pairs = (dupes?.duplicates ?? []).map((d) => ({ id: d.id, targetId: d.targetId }));
    if (pairs.length === 0) return;
    void run(async () => {
      await applyPendingDuplicates(pairs);
      setDupes(null);
    });
  }, [dupes, run]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const counts = status?.counts ?? {
    pending: pending.length,
    approved: approved.length,
    rejected: archive.filter((e) => e.status === "rejected").length,
    merged: archive.filter((e) => e.status === "merged").length,
    total: entries.length,
  };
  const sectionCount = (s: Section): number =>
    s === "pending" ? counts.pending : s === "approved" ? counts.approved : counts.rejected + counts.merged;

  const settings = status?.settings ?? null;
  const activeSources = settings
    ? (Object.entries(settings.sources) as Array<[keyof typeof settings.sources, boolean]>)
        .filter(([, on]) => on)
        .map(([k]) => t(`knowledge.origin.${k}`))
        .join(" / ")
    : "";

  return (
    <div className="go-root kb-root">
      <div className="go-head">
        <div className="go-head-main">
          <h1 className="go-h1">{t("knowledge.title")}</h1>
          <span className="go-head-sub">{t("knowledge.headerSub")}</span>
        </div>
        <div className="go-head-meta">
          {settings && (
            <span className="go-note kb-extract-state">
              {settings.enabled
                ? t("knowledge.extract.on", { sources: activeSources || t("knowledge.extract.none") })
                : t("knowledge.extract.off")}
              {" / "}
              {/* 47: 承認済みナレッジを次の調査プロンプトへ注入しているか。 */}
              {settings.inject?.enabled
                ? t("knowledge.inject.on", { max: settings.inject.maxEntries })
                : t("knowledge.inject.off")}
            </span>
          )}
          <button className="kb-btn" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
            {t("knowledge.extract.logToggle")}
          </button>
          <button className="go-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? t("knowledge.refreshing") : t("knowledge.refresh")}
          </button>
        </div>
      </div>

      {error && <div className="go-error">{t("knowledge.error.prefix", { message: error })}</div>}

      {showLog && (
        <div className="go-panel kb-log">
          <div className="go-panel-head">
            <span className="go-panel-title">{t("knowledge.extract.logTitle")}</span>
            {settings && (
              <span className="go-panel-note">
                {t("knowledge.extract.settingsSummary", {
                  max: settings.maxPerRun,
                  min: settings.minAnswerChars,
                  threshold: settings.similarityThreshold,
                  model: settings.model ?? t("knowledge.extract.defaultModel"),
                })}
                {settings.inject &&
                  ` / ${t("knowledge.inject.summary", {
                    max: settings.inject.maxEntries,
                    threshold: settings.inject.threshold,
                  })}`}
              </span>
            )}
          </div>
          <div className="kb-log-body">
            {(status?.log ?? []).length === 0 && <div className="go-note">{t("knowledge.extract.logEmpty")}</div>}
            {(status?.log ?? []).map((l) => (
              <div className="kb-log-row" key={`${l.runId}:${l.at}`}>
                <span className="kb-log-at go-mono">{formatDateTime(l.at, lang)}</span>
                <span className={`go-tag kb-log-${l.status}`}>{t(`knowledge.extract.status.${l.status}`)}</span>
                <span className="go-mono kb-log-origin">{t(`knowledge.origin.${l.origin}`)}</span>
                <span className="kb-log-detail">
                  {l.status === "created"
                    ? t("knowledge.extract.logCreated", {
                        n: l.created,
                        dup: l.duplicatePending,
                        // 71: 承認済みと同じ知見だったため作らなかった数。
                        dupApproved: l.duplicateApproved ?? 0,
                        similar: l.similarApproved,
                      })
                    : l.reasonCode
                      ? t(`knowledge.extract.reason.${l.reasonCode}`)
                      : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <nav className="kb-sections" role="tablist" aria-label={t("knowledge.sectionAria")}>
        {SECTIONS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={section === s}
            className={`kb-section${section === s ? " kb-section-on" : ""}`}
            onClick={() => setSection(s)}
          >
            {t(`knowledge.sections.${s}`)}
            <span className="kb-section-n">{sectionCount(s)}</span>
          </button>
        ))}
      </nav>

      {section === "pending" && (
        <>
          <div className="kb-bulk">
            <label className="kb-check">
              <input
                type="checkbox"
                checked={pending.length > 0 && selected.size === pending.length}
                onChange={() =>
                  setSelected(selected.size === pending.length ? new Set() : new Set(pending.map((e) => e.id)))
                }
                disabled={pending.length === 0}
              />
              <span>{t("knowledge.bulk.selectAll")}</span>
            </label>
            <span className="go-note kb-bulk-count">{t("knowledge.bulk.selected", { n: selected.size })}</span>
            <button
              className="kb-btn kb-btn-approve"
              disabled={busy || selected.size === 0}
              onClick={onBulkApprove}
            >
              {t("knowledge.bulk.approve")}
            </button>
            {/* 71: 承認済みと同じ知見の候補を洗い出して、まとめて統合する。 */}
            <button
              className="kb-btn kb-dedupe-scan"
              disabled={busy || scanning || pending.length === 0}
              onClick={() => void onScanDupes()}
              title={t("knowledge.dedupe.scanTitle")}
            >
              {scanning ? t("knowledge.dedupe.scanning") : t("knowledge.dedupe.scan")}
            </button>
          </div>

          {dupes && (
            <div className="go-panel kb-dedupe">
              <div className="go-panel-head">
                <span className="go-panel-title">{t("knowledge.dedupe.title")}</span>
                <span className="go-panel-note">
                  {t("knowledge.dedupe.summary", {
                    n: dupes.duplicates.length,
                    scanned: dupes.scanned,
                  })}
                </span>
                <button className="kb-btn" onClick={() => setDupes(null)}>
                  {t("knowledge.dedupe.close")}
                </button>
              </div>
              {dupes.error && (
                <div className="go-note kb-dedupe-note">{t("knowledge.dedupe.degraded")}</div>
              )}
              {dupes.duplicates.length === 0 ? (
                <div className="kb-empty-inner go-note">{t("knowledge.dedupe.none")}</div>
              ) : (
                <>
                  <div className="kb-dedupe-list">
                    {dupes.duplicates.map((d) => (
                      <div className="kb-dedupe-row" key={d.id}>
                        <span className="kb-dedupe-cand">{d.title}</span>
                        <span className="kb-dedupe-arrow" aria-hidden>
                          →
                        </span>
                        <span className="kb-dedupe-target">{d.targetTitle}</span>
                      </div>
                    ))}
                  </div>
                  <div className="kb-actions">
                    <button
                      className="kb-btn kb-btn-merge"
                      disabled={busy}
                      onClick={onApplyDupes}
                      title={t("knowledge.dedupe.applyTitle")}
                    >
                      {t("knowledge.dedupe.apply", { n: dupes.duplicates.length })}
                    </button>
                  </div>
                  <div className="go-note kb-dedupe-note">{t("knowledge.dedupe.note")}</div>
                </>
              )}
            </div>
          )}

          {pending.length === 0 && !loading && (
            <div className="go-panel kb-empty">
              <div className="go-note">{t("knowledge.pending.empty")}</div>
            </div>
          )}
          <div className="kb-list">
            {pending.map((e) => (
              <CandidateCard
                key={e.id}
                entry={e}
                selected={selected.has(e.id)}
                onToggleSelect={toggleSelect}
                approvedById={approvedById}
                busy={busy}
                onApprove={onApprove}
                onReject={onReject}
                onMerge={onMerge}
                onOpenHistoryFocus={onOpenHistoryFocus}
              />
            ))}
          </div>
        </>
      )}

      {section === "approved" && (
        <>
          <div className="kb-filter">
            <input
              className="kb-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("knowledge.approved.searchPlaceholder")}
              aria-label={t("knowledge.approved.searchAria")}
            />
            <span className="go-note kb-filter-count">
              {t("knowledge.approved.count", { shown: filteredApproved.length, total: approved.length })}
            </span>
            {/* 並べ替え(47)。未参照の知見を見つけるための「参照が古い順」を含む。 */}
            <select
              className="kb-input kb-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label={t("knowledge.approved.sortAria")}
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`knowledge.approved.sort.${s}`)}
                </option>
              ))}
            </select>
            <span className="go-note kb-filter-count">
              {t("knowledge.refs.unusedCount", { n: approved.filter((e) => (e.refCount ?? 0) === 0).length })}
            </span>
          </div>
          {tags.length > 0 && (
            <div className="kb-tagbar">
              <button className={`kb-tag${tag === null ? " kb-tag-on" : ""}`} onClick={() => setTag(null)}>
                {t("knowledge.approved.allTags")}
              </button>
              {tags.map((tg) => (
                <button
                  key={tg.name}
                  className={`kb-tag${tag === tg.name ? " kb-tag-on" : ""}`}
                  onClick={() => setTag(tag === tg.name ? null : tg.name)}
                >
                  #{tg.name}
                  <span className="kb-tag-n">{tg.count}</span>
                </button>
              ))}
            </div>
          )}
          {filteredApproved.length === 0 && !loading && (
            <div className="go-panel kb-empty">
              <div className="go-note">
                {approved.length === 0 ? t("knowledge.approved.empty") : t("knowledge.approved.noMatch")}
              </div>
            </div>
          )}
          <div className="kb-list">
            {filteredApproved.map((e) => (
              <ApprovedCard
                key={e.id}
                entry={e}
                busy={busy}
                onSave={onSave}
                onReject={onReject}
                onTag={(tg) => setTag(tag === tg ? null : tg)}
                activeTag={tag}
                onOpenHistoryFocus={onOpenHistoryFocus}
                highlighted={highlightEntryId === e.id}
                onHighlightDone={() => setHighlightEntryId(null)}
              />
            ))}
          </div>
        </>
      )}

      {section === "archive" && (
        <div className="go-panel kb-arch-panel">
          <div className="go-panel-head">
            <span className="go-panel-title">{t("knowledge.archive.title")}</span>
            <span className="go-panel-note">{t("knowledge.archive.note")}</span>
          </div>
          {archive.length === 0 && <div className="kb-empty-inner go-note">{t("knowledge.archive.empty")}</div>}
          {archive.map((e) => (
            <ArchiveRow
              key={e.id}
              entry={e}
              byId={byId}
              busy={busy}
              onApprove={onApprove}
              onOpenHistoryFocus={onOpenHistoryFocus}
            />
          ))}
        </div>
      )}

      <div className="go-foot">{t("knowledge.foot")}</div>
    </div>
  );
}
