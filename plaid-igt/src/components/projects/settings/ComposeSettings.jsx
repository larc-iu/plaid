import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { SearchInput, ListCount, ListPager, SortHeader } from '@ui/components/shared/list-search';
import { listPrefKey, useStickySort } from '@ui/hooks/useStickyState.js';
import { sortRows } from '@ui/lib/sortRows.js';
import { timeAgo, fullTimestamp } from '@ui/lib/formatTime.js';
import { usePagedList, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { notifyError } from '@/utils/feedback';
import {
  CHANGED_ELSEWHERE,
  expectStored,
  isConfigConflict,
  withStoredConfig,
} from '@ui/domain/configCells.js';
import { IGT_NAMESPACE, readCompose } from '@/domain/igtConfig';
import {
  builtInRow,
  composeRows,
  isBuiltInCode,
  rowsToConfig,
  validateCode,
  DUPLICATE_CODE,
} from '@/domain/composeConfig';
import { textIncludes } from '@ui/domain/collation.js';
import { TYPE } from '@ui/lib/typeScale.js';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

const byCode = (a, b) => a.code.toLowerCase().localeCompare(b.code.toLowerCase());

// A row's identity for React, fixed when the row appears and never derived from
// what is being typed into it. Deriving the key from the code (or from whether
// the row counts as changed) remounts the row on the FIRST keystroke, which
// takes focus out of the field the person is typing in.
//
// `was` is the row as stored, which is what the list sorts by: a row being
// typed into keeps its place until the next save, and a row added since has
// no `was` and stays at the top.
let nextUid = 0;
const withUid = (row) => ({
  ...row,
  uid: `row-${nextUid++}`,
  was: {
    code: row.code,
    char: row.char,
    description: row.description,
    origin: row.origin,
    modified: row.modified,
  },
});

// What a list of rows says, without the row identities or the order rows
// were added in, so two lists that would store the same thing compare equal.
// The time a row was changed is left out: a save sets it, so the list just
// saved and the list read back after it still compare equal. A project's own
// code deleted here is not stored at all.
const rowsKey = (rows) =>
  JSON.stringify(
    rows
      .filter((r) => r.origin !== 'removed' || isBuiltInCode(r.code))
      .map(({ uid: _uid, was: _was, modified: _modified, elsewhere: _elsewhere, ...row }) => row)
      .sort(byCode),
  );

const sameRow = (a, b) =>
  a.code === b.code &&
  a.char === b.char &&
  (a.description || '') === (b.description || '') &&
  a.origin === b.origin;

// The list read again (`now`) with this page's own edits on it. A row the
// page did not change shows what is stored now. A row it changed keeps what
// was typed, with what is stored now as `elsewhere` when someone else changed
// it too, a delete here included. A row the page added stays, and one it
// changed that was deleted elsewhere stays, marked deleted elsewhere.
// `before` is the list the edits were made on, and `ours` says `now` is what
// this page itself stored (so nobody else changed a row).
const rebase = (draft, before, now, ours) => {
  const mine = new Map(draft.filter((d) => d.was).map((d) => [d.was.code, d]));
  const added = draft.filter((d) => !d.was);
  const rows = [];
  for (const n of now) {
    const d = mine.get(n.code);
    if (!d) {
      if (!before.some((b) => b.code === n.code)) rows.push(n);
      continue;
    }
    if (sameRow(d, d.was)) rows.push({ ...n, uid: d.uid });
    else
      rows.push({
        ...d,
        was: n.was,
        // A row not changed again since the last read keeps its mark.
        elsewhere: ours || sameRow(n, d) ? null : !sameRow(n, d.was) ? n : (d.elsewhere ?? null),
      });
  }
  // A row changed here whose code is stored no more stays, as a new one.
  for (const d of mine.values()) {
    if (d.origin === 'removed' || sameRow(d, d.was)) continue;
    if (now.some((n) => n.code === d.was.code)) continue;
    added.push({ ...d, was: null, elsewhere: ours ? null : { origin: 'removed' } });
  }
  return [...added, ...rows];
};

const SORTS = {
  code: { sort: (r) => r.was.code },
  char: { sort: (r) => r.was.char },
  description: { sort: (r) => r.was.description || null },
  modified: { sort: (r) => r.was.modified },
};
const SORT_KEYS = Object.keys(SORTS);
const DEFAULT_SORT = { key: 'modified', dir: 'desc' };
const sortKey = (r) => r.was.code;

// A built-in code's row: one listed as a built-in when the list was read. A
// new row stays the project's own, an editable code, even when what is typed
// into it is a built-in code: the duplicate check says so.
const isBuiltInRow = (r) => !!r.was && isBuiltInCode(r.was.code);

// How long a row the reader was taken to stays marked (located-flash).
const FLASH_MS = 2400;
const NOTE_SHOWN = 20;

// "This code already exists: \sw is ə (schwa)." for the row `other`.
const clashText = (other) => {
  const note = other.description || '';
  const cut = note.length > NOTE_SHOWN ? `${note.slice(0, NOTE_SHOWN)}…` : note;
  const what = other.char ? ` is ${other.char}${cut ? ` (${cut})` : ''}` : '';
  return `${DUPLICATE_CODE.slice(0, -1)}: \\${other.code}${what}.`;
};

// "Changed elsewhere to ʔ (by Ana)." under a row someone else changed too,
// `row.elsewhere` being the row as stored now.
const elsewhereText = (row) => {
  const r = row.elsewhere;
  if (r.origin === 'removed') return 'Deleted elsewhere.';
  const note = r.description || '';
  const cut = note.length > NOTE_SHOWN ? `${note.slice(0, NOTE_SHOWN)}…` : note;
  const changed = `Changed elsewhere to ${r.char}${cut ? ` (${cut})` : ''}.`;
  return row.origin === 'removed' ? `Deleted on save. ${changed}` : changed;
};

const edited = (r) =>
  !r.was ||
  r.code !== r.was.code ||
  r.char !== r.was.char ||
  (r.description || '') !== (r.was.description || '');

// The header and every row share these tracks, so the columns line up and the
// buttons keep a cell of their own whatever a note holds.
const GRID = 'grid grid-cols-[6rem_6rem_minmax(0,1fr)_8rem_4rem] items-center gap-2 px-3';

/**
 * Settings → Text and vocab → Special characters. Every code is an entry here:
 * the built-in ones can be pointed somewhere else or deleted, and a project
 * can add its own. Only what a project actually changed is stored, so a code
 * nobody touched still picks up a correction later. A deleted built-in is
 * stored as removed and not listed. Restore built-in codes brings them all
 * back. Each stored code carries the time of the save that last changed it.
 */
export const ComposeSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const saved = useMemo(() => composeRows(project?.config).map(withUid), [project?.config]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');

  // Re-sync when the project reloads. Edits not saved yet stay, on the list
  // as stored now.
  const prevSaved = useRef(saved);
  // The list this page last stored, as rowsKey gives it.
  const wrote = useRef(null);
  useEffect(() => {
    const before = prevSaved.current;
    prevSaved.current = saved;
    setDraft((d) => {
      const key = rowsKey(d);
      return key === rowsKey(before) || key === rowsKey(saved)
        ? saved
        : rebase(d, before, saved, rowsKey(saved) === wrote.current);
    });
  }, [saved]);

  const dirty = rowsKey(draft) !== rowsKey(saved);
  // Leaving the section, or the page, with an edit not saved asks first.
  useUnsavedDraft(dirty ? 'The change to special characters' : null);
  const problemsByCode = useMemo(() => {
    const m = new Map();
    for (const row of draft) m.set(row, validateCode(row, draft));
    return m;
  }, [draft]);
  const canSave = dirty && !saving && [...problemsByCode.values()].every((p) => p.length === 0);

  const [sort, onSort] = useStickySort(
    listPrefKey('sort', 'compose-codes', projectId),
    DEFAULT_SORT,
    SORT_KEYS,
  );

  // A deleted built-in code is stored as removed and shown nowhere.
  // A row deleted here that someone else changed is shown, with that change.
  const live = useMemo(() => draft.filter((r) => r.origin !== 'removed' || r.elsewhere), [draft]);
  const anyRemoved = draft.some((r) => r.origin === 'removed' && isBuiltInRow(r));
  const changedCount = live.filter((r) => r.origin === 'changed' || r.origin === 'added').length;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return live;
    // A code is shown with its backslash and stored without one.
    const code = needle.replace(/^\\/, '');
    return live.filter(
      (r) =>
        textIncludes(r.code, code) ||
        r.char === q.trim() ||
        textIncludes(r.description || '', needle),
    );
  }, [live, q]);

  const ordered = useMemo(
    () => [
      ...matches.filter((r) => !r.was),
      ...sortRows(
        matches.filter((r) => r.was),
        SORTS[sort.key],
        sort.dir,
        sortKey,
      ),
    ],
    [matches, sort],
  );

  const paged = usePagedList(ordered, {
    pageSize: TALL_LIST_PAGE_SIZE,
    resetKey: `${q}:${sort.key}:${sort.dir}`,
  });

  // The other listed row with this row's code, for the duplicate message.
  const clashOf = (row) => live.find((o) => o !== row && o.code === row.code);

  // Show: the row a code clashes with, brought onto the page, scrolled to the
  // middle, marked and focused. The search is cleared when it hides the row.
  const listRef = useRef(null);
  const [locate, setLocate] = useState(null);
  const show = (other) => {
    if (!matches.includes(other)) setQ('');
    setLocate(other.uid);
  };
  const { page, setPage } = paged;
  useEffect(() => {
    if (!locate) return;
    const at = ordered.findIndex((r) => r.uid === locate);
    if (at < 0) {
      setLocate(null);
      return;
    }
    // Set even when it is the page shown: a search just cleared turns the
    // list back to its first page in this same pass.
    const target = Math.floor(at / TALL_LIST_PAGE_SIZE);
    setPage(target);
    if (target !== page) return;
    const el = listRef.current?.querySelector(`[data-row-uid="${locate}"]`);
    if (!el) return;
    setLocate(null);
    el.scrollIntoView({ block: 'center' });
    el.classList.add('located-flash');
    setTimeout(() => el.classList.remove('located-flash'), FLASH_MS);
    el.querySelector('input, button')?.focus();
  }, [locate, ordered, page, setPage]);

  const patch = (row, next) =>
    setDraft((rows) => rows.map((r) => (r === row ? { ...r, ...next } : r)));

  const editRow = (row, next) => {
    const merged = { ...row, ...next };
    const base = builtInRow(row.code);
    const origin = !base
      ? 'added'
      : merged.char === base.char && !merged.description
        ? 'built-in'
        : 'changed';
    patch(row, { ...next, origin });
  };

  // A stored row is kept, marked deleted, so a read of the list again knows
  // it was deleted here. A row added since goes.
  const removeRow = (row) => {
    if (row.was) patch(row, { origin: 'removed', elsewhere: null });
    else setDraft((rows) => rows.filter((r) => r !== row));
  };

  const resetRow = (row) => {
    const base = builtInRow(row.code);
    if (base) patch(row, { ...base, origin: 'built-in' });
  };

  // Every deleted built-in code back as shipped. One whose code a row uses
  // again is dropped instead, so no two rows share a code.
  const restoreBuiltIns = () =>
    setDraft((rows) => {
      const used = new Set(rows.filter((r) => r.origin !== 'removed').map((r) => r.code));
      const restored = (r) => r.origin === 'removed' && isBuiltInRow(r);
      return rows
        .filter((r) => !restored(r) || !used.has(r.code))
        .map((r) => (restored(r) ? { ...r, ...builtInRow(r.code), origin: 'built-in' } : r));
    });

  const addRow = () => {
    setQ('');
    setDraft((rows) => [
      { ...withUid({ code: '', char: '', description: '', origin: 'added' }), was: null },
      ...rows,
    ]);
    paged.setPage(0);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (!client) throw new Error('Not authenticated');
      const existing = readCompose(project?.config) || {};
      // A row changed in this save takes the time of the save.
      const now = new Date().toISOString();
      const stamped = draft.map((r) =>
        r.origin !== 'removed' && edited(r) ? { ...r, modified: now } : r,
      );
      const value = { ...existing, ...rowsToConfig(stamped) };
      await client.projects.setConfig(
        projectId,
        IGT_NAMESPACE,
        'compose',
        value,
        undefined,
        expectStored(project, IGT_NAMESPACE, 'compose'),
      );
      // What the edits made after this save are made on.
      const written = composeRows(
        withStoredConfig(project, IGT_NAMESPACE, 'compose', value).config,
      ).map(withUid);
      prevSaved.current = written;
      wrote.current = rowsKey(written);
      // Save stays held until the project is read again, so a next save
      // expects what this one stored. The save has landed by now, so a read
      // that fails is not a failed save.
      await Promise.resolve(onProjectUpdate?.()).catch((err) =>
        console.error('Failed to reload the project:', err),
      );
    } catch (err) {
      console.error('Failed to save the project codes:', err);
      // Someone else saved since: show what is stored now, the edits on it.
      notifyError(isConfigConflict(err) ? CHANGED_ELSEWHERE : err, 'Failed to save the codes');
      if (isConfigConflict(err)) onProjectUpdate?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className={TYPE.card}>Special characters</h2>
      <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
        Type a backslash and a code in any field: <code>\sw</code> for ə, <code>\00</code> for ∅.
      </p>

      <div className="flex max-w-4xl flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ListCount shown={matches.length} total={live.length} noun="code" />
          <SearchInput
            className="w-full max-w-[20rem]"
            inputClassName="h-8"
            placeholder="Search codes…"
            value={q}
            onChange={setQ}
          />
          {changedCount > 0 && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              · {changedCount} changed by this project
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {anyRemoved && (
              <Button variant="ghost" size="sm" onClick={restoreBuiltIns}>
                Restore built-in codes
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="h-4 w-4" /> Add code
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <div className="min-w-[36rem]" ref={listRef}>
            <div className="border-b bg-muted/30 py-2 text-xs">
              <div className={GRID} data-compose-header>
                <SortHeader field="code" label="Code" sort={sort} onSort={onSort} />
                <SortHeader field="char" label="Character" sort={sort} onSort={onSort} />
                <SortHeader field="description" label="Note" sort={sort} onSort={onSort} />
                <SortHeader field="modified" label="Last modified" sort={sort} onSort={onSort} />
                <span />
              </div>
            </div>
            <ListPager {...paged} onPage={paged.setPage} position="top" />
            {paged.pageItems.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">No codes match “{q}”.</p>
            )}
            {paged.pageItems.map((row) => {
              const problems = problemsByCode.get(row) || [];
              const builtIn = isBuiltInRow(row);
              const stored = row.was?.modified;
              return (
                <div
                  key={row.uid}
                  className="border-b py-1.5 last:border-b-0"
                  data-code-row={row.code}
                  data-row-uid={row.uid}
                >
                  <div className={GRID} data-compose-grid>
                    <div className="min-w-0">
                      {builtIn ? (
                        <code className="text-sm">{`\\${row.code}`}</code>
                      ) : (
                        <Input
                          value={row.code}
                          onChange={(e) => editRow(row, { code: e.target.value })}
                          aria-label="Code"
                          className="h-8 font-mono"
                          spellCheck={false}
                          aria-invalid={problems.length > 0 || undefined}
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <Input
                        compose
                        value={row.char}
                        onChange={(e) => editRow(row, { char: e.target.value })}
                        aria-label="Character"
                        className="h-8 text-base"
                        spellCheck={false}
                      />
                    </div>
                    <div className="min-w-0">
                      <Input
                        value={row.description || ''}
                        onChange={(e) => editRow(row, { description: e.target.value })}
                        aria-label="Note"
                        className="h-8"
                      />
                    </div>
                    <span
                      className="min-w-0 truncate text-xs text-muted-foreground"
                      title={fullTimestamp(stored) || undefined}
                      data-modified
                    >
                      {timeAgo(stored)}
                    </span>
                    <div className="flex min-w-0 items-center justify-end gap-1">
                      {row.origin !== 'built-in' && builtIn && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => resetRow(row)}
                          title="Reset to built-in"
                          aria-label={`Reset code ${row.code}`}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => removeRow(row)}
                        title="Delete"
                        aria-label={row.code ? `Delete code ${row.code}` : 'Delete code'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {row.elsewhere && (
                    <p className="px-3 pt-1 text-xs text-muted-foreground">{elsewhereText(row)}</p>
                  )}
                  {problems.map((p) => {
                    const other = p === DUPLICATE_CODE ? clashOf(row) : null;
                    return (
                      <p key={p} className="px-3 pt-1 text-xs text-destructive">
                        {other ? clashText(other) : p}
                        {other && (
                          <>
                            {' '}
                            <Button
                              variant="link"
                              className="h-auto p-0 text-xs"
                              onClick={() => show(other)}
                            >
                              Show
                            </Button>
                          </>
                        )}
                      </p>
                    );
                  })}
                </div>
              );
            })}
            <ListPager {...paged} onPage={paged.setPage} />
          </div>
        </div>

        <div>
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
