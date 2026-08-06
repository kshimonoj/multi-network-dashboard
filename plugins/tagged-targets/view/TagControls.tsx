// タグ付き Client / Device — タグ定義の管理と、対象へのタグ付与 UI(57 §3-3)。
//
// タグ名・覚え書き・ノートは**ユーザーが入力した実行時データなので翻訳しない**
// (CLAUDE.md「実行時の記録として残る文言は翻訳しない」)。翻訳するのはラベル・ボタン・注記だけ。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT, type TFunc } from "../../../src/i18n";
import { createTag, deleteTag, deleteTarget, fetchTagUsage, updateTag, upsertTarget } from "./api";
import { toColonMac } from "./format";
import { MacText } from "./primitives";
import { TAG_COLORS, type TagColor, type TagDef, type TagStoreFile, type TargetAssignment, type TargetKind } from "./types";

export function TagPill({ tag, onRemove }: { tag: TagDef; onRemove?: () => void }) {
  return (
    <span className={`tt-tag tt-tag-${tag.color}`} title={tag.description ?? undefined}>
      {tag.name}
      {onRemove && (
        <button type="button" className="tt-tag-x" onClick={onRemove} aria-label={`remove ${tag.name}`}>
          ×
        </button>
      )}
    </span>
  );
}

/** 1 対象に付いているタグの表示 + その場での付け外し。 */
export function TagAssigner({
  assignment,
  tags,
  onStore,
  onError,
}: {
  assignment: TargetAssignment;
  tags: TagDef[];
  onStore: (s: TagStoreFile) => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const assigned = useMemo(
    () => assignment.tagIds.map((id) => tags.find((x) => x.id === id)).filter((x): x is TagDef => Boolean(x)),
    [assignment.tagIds, tags],
  );

  const toggle = useCallback(
    async (tagId: string) => {
      const next = assignment.tagIds.includes(tagId)
        ? assignment.tagIds.filter((x) => x !== tagId)
        : [...assignment.tagIds, tagId];
      try {
        const res = await upsertTarget({ kind: assignment.kind, key: assignment.key, tagIds: next });
        onStore(res.store);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [assignment, onStore, onError],
  );

  return (
    <span className="tt-tag-cell">
      {assigned.map((tag) => (
        <TagPill key={tag.id} tag={tag} onRemove={() => void toggle(tag.id)} />
      ))}
      <span className="tt-tag-picker-wrap">
        <button
          type="button"
          className="tt-tag-add"
          onClick={() => setOpen((v) => !v)}
          title={t("taggedTargets.tag.assignTitle")}
        >
          + {t("taggedTargets.tag.assign")}
        </button>
        {open && (
          <div className="tt-tag-picker" role="menu">
            {tags.length === 0 && <div className="go-note">{t("taggedTargets.tag.noneDefined")}</div>}
            {tags.map((tag) => (
              <label key={tag.id} className="tt-tag-picker-row">
                <input
                  type="checkbox"
                  checked={assignment.tagIds.includes(tag.id)}
                  onChange={() => void toggle(tag.id)}
                />
                <TagPill tag={tag} />
              </label>
            ))}
            <button type="button" className="tt-tag-picker-close" onClick={() => setOpen(false)}>
              {t("taggedTargets.tag.close")}
            </button>
          </div>
        )}
      </span>
    </span>
  );
}

/** タグ定義の一覧・追加・改名・色変更・削除。 */
export function TagManager({
  store,
  onStore,
  onError,
}: {
  store: TagStoreFile;
  onStore: (s: TagStoreFile) => void;
  onError: (m: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("blue");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const add = useCallback(async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await createTag({ name: name.trim(), color });
      onStore(res.store);
      setName("");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [name, color, busy, onStore, onError]);

  // 削除は「N 件の対象から外れます」を必ず出してから(57 §3-3)。
  const remove = useCallback(
    async (tag: TagDef) => {
      let count = 0;
      try {
        count = (await fetchTagUsage(tag.id)).count;
      } catch {
        /* 件数が引けなくても確認は出す */
      }
      if (!window.confirm(t("taggedTargets.tag.deleteConfirm", { name: tag.name, n: count }))) return;
      try {
        const res = await deleteTag(tag.id);
        onStore(res.store);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [t, onStore, onError],
  );

  const commitRename = useCallback(
    async (tag: TagDef) => {
      const trimmed = editName.trim();
      setEditing(null);
      if (!trimmed || trimmed === tag.name) return;
      try {
        const res = await updateTag(tag.id, { name: trimmed });
        onStore(res.store);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [editName, onStore, onError],
  );

  const recolor = useCallback(
    async (tag: TagDef, c: TagColor) => {
      try {
        const res = await updateTag(tag.id, { color: c });
        onStore(res.store);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [onStore, onError],
  );

  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of store.assignments) for (const id of a.tagIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [store.assignments]);

  return (
    <div className="tt-tag-manager">
      <div className="tt-tag-manager-add">
        <input
          className="tt-input"
          value={name}
          placeholder={t("taggedTargets.tag.namePlaceholder")}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <ColorPicker value={color} onChange={setColor} />
        <button className="go-refresh" onClick={() => void add()} disabled={busy || !name.trim()}>
          {t("taggedTargets.tag.create")}
        </button>
      </div>

      {store.tags.length === 0 ? (
        <div className="go-note">{t("taggedTargets.tag.noneDefinedHint")}</div>
      ) : (
        <ul className="tt-tag-manager-list">
          {store.tags.map((tag) => (
            <li key={tag.id} className="tt-tag-manager-row">
              {editing === tag.id ? (
                <input
                  className="tt-input"
                  value={editName}
                  autoFocus
                  maxLength={60}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => void commitRename(tag)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRename(tag);
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="tt-tag-rename"
                  onClick={() => {
                    setEditing(tag.id);
                    setEditName(tag.name);
                  }}
                  title={t("taggedTargets.tag.renameTitle")}
                >
                  <TagPill tag={tag} />
                </button>
              )}
              <ColorPicker value={tag.color} onChange={(c) => void recolor(tag, c)} />
              <span className="go-panel-note">
                {t("taggedTargets.tag.usage", { n: usage.get(tag.id) ?? 0 })}
              </span>
              <button type="button" className="tt-danger-btn" onClick={() => void remove(tag)}>
                {t("taggedTargets.tag.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  const t = useT();
  return (
    <span className="tt-color-picker" title={t("taggedTargets.tag.color")}>
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`tt-color-dot tt-tag-${c}${value === c ? " on" : ""}`}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
    </span>
  );
}

/**
 * 対象の追加(MAC / ホスト名 / シリアルで検索して選ぶ)。
 * ランダム MAC と判定できたら**その場で警告を出す**(57 §3-5)。黙って登録して
 * 後から行方不明にするより、登録時に伝えるほうが親切。
 */
export function AddTargetPanel({
  kind,
  tags,
  onStore,
  onError,
  onClose,
  search,
}: {
  kind: TargetKind;
  tags: TagDef[];
  onStore: (s: TagStoreFile) => void;
  onError: (m: string) => void;
  onClose: () => void;
  search: (kind: TargetKind, q: string) => Promise<import("./types").SearchResponse>;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<import("./types").SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // 入力が落ち着いてから 1 回だけ検索する(1 文字ごとに org 全体を舐めない)。
  useEffect(() => {
    if (q.trim().length < 2) {
      setRes(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void search(kind, q.trim())
        .then((r) => {
          if (!cancelled) setRes(r);
        })
        .catch((err) => {
          if (!cancelled) onError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, kind, search, onError]);

  const add = useCallback(
    async (hit: import("./types").SearchHit) => {
      try {
        const r = await upsertTarget({
          kind,
          key: hit.key,
          serial: hit.serial,
          tagIds: selectedTags,
          label: hit.label,
          lastSeen: hit.siteId
            ? { platform: hit.platform, siteId: hit.siteId, siteName: hit.siteName, at: new Date().toISOString() }
            : undefined,
          randomMac: hit.randomMac === true,
        });
        onStore(r.store);
        onClose();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [kind, selectedTags, onStore, onError, onClose],
  );

  const hits = res?.hits ?? [];
  const showManual = Boolean(res?.manual) && hits.every((h) => h.key !== res?.manual?.key);

  return (
    <div className="tt-add-panel">
      <div className="tt-add-head">
        <span className="tt-section-title">{t(`taggedTargets.add.title.${kind}`)}</span>
        <button type="button" className="tt-tag-picker-close" onClick={onClose}>
          {t("taggedTargets.tag.close")}
        </button>
      </div>

      <input
        className="tt-input tt-add-input"
        value={q}
        autoFocus
        placeholder={t(`taggedTargets.add.placeholder.${kind}`)}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="go-note">{t("taggedTargets.add.hint")}</div>

      {tags.length > 0 && (
        <div className="tt-add-tags">
          <span className="tt-field-label">{t("taggedTargets.add.applyTags")}</span>
          {tags.map((tag) => (
            <label key={tag.id} className="tt-tag-picker-row">
              <input
                type="checkbox"
                checked={selectedTags.includes(tag.id)}
                onChange={(e) =>
                  setSelectedTags((prev) =>
                    e.target.checked ? [...prev, tag.id] : prev.filter((x) => x !== tag.id),
                  )
                }
              />
              <TagPill tag={tag} />
            </label>
          ))}
        </div>
      )}

      {busy && <div className="go-loading">{t("taggedTargets.add.searching")}</div>}
      {res?.errors.map((e) => (
        <div key={e.platform} className="go-inline-error">
          {t("taggedTargets.add.searchError", { platform: e.platform, error: e.error })}
        </div>
      ))}

      <ul className="tt-add-results">
        {hits.map((h) => (
          <li key={`${h.platform}:${h.key}`} className="tt-add-result">
            <span className={`tt-plat tt-plat-${h.platform}`}>
              {t(`taggedTargets.platform.${h.platform}`)}
            </span>
            <span className="tt-add-result-label">{h.label ?? toColonMac(h.key)}</span>
            <MacText value={h.key} />
            {h.sub && <span className="go-panel-note">{h.sub}</span>}
            {h.siteName && <span className="go-panel-note">{h.siteName}</span>}
            {h.randomMac === true && (
              <span className="tt-random-badge" title={t(`taggedTargets.randomMac.source.${h.randomMacSource ?? "mac-bit"}`)}>
                {t("taggedTargets.randomMac.badge")}
              </span>
            )}
            <button className="go-refresh" onClick={() => void add(h)}>
              {t("taggedTargets.add.button")}
            </button>
          </li>
        ))}
        {showManual && res?.manual && (
          <li className="tt-add-result tt-add-manual">
            <span className="go-panel-note">{t("taggedTargets.add.manualNote")}</span>
            <MacText value={res.manual.key} />
            {res.manual.randomMac === true && (
              <span className="tt-random-badge">{t("taggedTargets.randomMac.badge")}</span>
            )}
            <button className="go-refresh" onClick={() => void add(res.manual!)}>
              {t("taggedTargets.add.buttonManual")}
            </button>
          </li>
        )}
      </ul>

      {hits.some((h) => h.randomMac === true) && (
        <div className="go-note go-note-warn">{t("taggedTargets.randomMac.warning")}</div>
      )}
    </div>
  );
}

/** 対象の登録解除(行のメニューから。57 §3-3)。 */
export async function removeTarget(
  t: TFunc,
  assignment: TargetAssignment,
  onStore: (s: TagStoreFile) => void,
  onError: (m: string) => void,
): Promise<void> {
  const label = assignment.label ?? toColonMac(assignment.key);
  if (!window.confirm(t("taggedTargets.target.removeConfirm", { name: label }))) return;
  try {
    const r = await deleteTarget(assignment.kind, assignment.key);
    onStore(r.store);
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
}
