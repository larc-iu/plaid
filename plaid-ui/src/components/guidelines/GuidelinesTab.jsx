import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Input } from '../ui/input.jsx';
import { SafeMarkdown } from '../shared/markdown.jsx';
import { ListCount, ListPager, SearchInput } from '../shared/list-search.jsx';
import { Suspended } from '../shared/Suspended.jsx';
import { useConfirm } from '../shared/ConfirmProvider.jsx';
import { useLatestCall } from '../../hooks/useLatestCall.js';
import { pageKey, TALL_LIST_PAGE_SIZE, usePagedList } from '../../hooks/usePagedList.js';
import { collationKey, compareText, textIncludes } from '../../domain/collation.js';
import { humanizeError } from '../../lib/errors.js';
import { lazyNamed } from '../../lib/lazyNamed.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';
import { cn } from '../../lib/utils.js';

// A project's annotation manual: the conventions the people on it have agreed
// to, written down where everyone (and the assistant) can read them.
//
// One screen for every app. There is no per-app adapter the way the assistant
// has one, because the assistant's adapter exists to give a cited sentence an
// address in that app's editor and a guideline has no such thing: it is a
// project-level document and reads the same in IGT and UD.
//
// The editor is LAZY. It is the only thing in the package that pulls in Tiptap,
// so a reader who never edits never downloads it. Do not turn this into a
// static import.
const GuidelineEditor = lazyNamed(() => import('./GuidelineEditor.jsx'), 'GuidelineEditor');

const SEARCH_FROM = 8;

/** The list order the assistant also uses: pinned first, then by title. */
const inReadingOrder = (entries) =>
  [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || compareText(a.title, b.title));

const blankDraft = () => ({ id: null, title: '', summary: '', body: '', pinned: false });

/** One row in the list. */
const GuidelineRow = ({ entry, selected, onSelect }) => (
  <button
    type="button"
    onClick={() => onSelect(entry.id)}
    aria-current={selected ? 'true' : undefined}
    className={cn(
      'flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left transition-colors last:border-b-0',
      selected ? 'bg-accent' : 'hover:bg-accent/50',
    )}
  >
    <span className="flex items-center gap-1.5">
      {entry.pinned && (
        <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
      )}
      <span className="truncate text-sm font-medium">{entry.title}</span>
    </span>
    <span className="line-clamp-2 text-xs text-muted-foreground">{entry.summary}</span>
  </button>
);

export function GuidelinesTab({ client, projectId, canWrite }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [opened, setOpened] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  const confirm = useConfirm();
  const begin = useLatestCall();
  const beginBody = useLatestCall();

  const selectedId = params.get('guideline');

  const setSelectedId = useCallback(
    (id) =>
      setParams(
        (prev) => {
          // Copy so the rest of the query (`?tab=`) survives.
          const out = new URLSearchParams(prev);
          if (id) out.set('guideline', id);
          else out.delete('guideline');
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );

  const load = useCallback(async () => {
    const isCurrent = begin();
    setLoading(true);
    try {
      // The index only: each entry carries its body's LENGTH, not its text.
      const rows = await client.guidelines.list(projectId);
      if (!isCurrent()) return;
      setEntries(rows);
      setLoadError(null);
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError(humanizeError(error, 'Could not load the guidelines.'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [begin, client, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // The body is fetched when a guideline is opened, never with the list.
  useEffect(() => {
    if (!selectedId) {
      setOpened(null);
      return;
    }
    const isCurrent = beginBody();
    let cancelled = false;
    (async () => {
      try {
        const full = await client.guidelines.get(selectedId);
        if (cancelled || !isCurrent()) return;
        setOpened(full);
      } catch (error) {
        if (cancelled || !isCurrent()) return;
        setOpened(null);
        notifyError(humanizeError(error, 'Could not open that guideline.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beginBody, client, selectedId]);

  const ordered = useMemo(() => inReadingOrder(entries), [entries]);
  const matched = useMemo(
    () =>
      query
        ? ordered.filter((g) => textIncludes(g.title, query) || textIncludes(g.summary, query))
        : ordered,
    [ordered, query],
  );
  const paged = usePagedList(matched, {
    pageSize: TALL_LIST_PAGE_SIZE,
    resetKey: query,
    storageKey: pageKey('guidelines', projectId),
  });

  const startNew = () => {
    setSelectedId(null);
    setDraft(blankDraft());
  };

  const startEdit = () => opened && setDraft({ ...opened, body: opened.body ?? '' });

  const save = async () => {
    const title = draft.title.trim();
    const summary = draft.summary.trim();
    if (!title || !summary) {
      notifyError('A guideline needs a title and a summary.');
      return;
    }
    setSaving(true);
    try {
      if (draft.id) {
        await client.guidelines.update(draft.id, {
          title,
          summary,
          body: draft.body,
          pinned: draft.pinned,
        });
      } else {
        const { id } = await client.guidelines.create(projectId, title, summary, {
          body: draft.body,
          pinned: draft.pinned,
        });
        setSelectedId(id);
      }
      setDraft(null);
      await load();
      // Reopen so the pane shows what was saved rather than what was loaded.
      if (draft.id) setOpened(await client.guidelines.get(draft.id));
      notifySuccess(draft.id ? 'Guideline saved.' : 'Guideline created.');
    } catch (error) {
      notifyError(humanizeError(error, 'Could not save the guideline.'));
    } finally {
      setSaving(false);
    }
  };

  const togglePinned = async () => {
    const next = !opened.pinned;
    try {
      const updated = await client.guidelines.update(opened.id, { pinned: next });
      setOpened(updated);
      setEntries((prev) => prev.map((g) => (g.id === opened.id ? { ...g, pinned: next } : g)));
    } catch (error) {
      notifyError(humanizeError(error, 'Could not change that.'));
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete guideline?',
      description: opened.title,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await client.guidelines.delete(opened.id);
      setSelectedId(null);
      await load();
      notifySuccess('Guideline deleted.');
    } catch (error) {
      notifyError(humanizeError(error, 'Could not delete the guideline.'));
    }
  };

  const editing = draft !== null;
  // Titles are not unique and the server does not police them, so this is a
  // note and not a blocker: it is said while the title is being typed, which is
  // before there is any work to lose, and Save goes through either way.
  const titleTaken =
    editing &&
    draft.title.trim() &&
    entries.some(
      (g) => g.id !== draft.id && collationKey(g.title) === collationKey(draft.title.trim()),
    );

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex w-full shrink-0 flex-col gap-2 lg:w-80">
        <div className="flex items-center gap-2">
          {entries.length >= SEARCH_FROM && (
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search guidelines…"
              className="flex-1"
            />
          )}
          {canWrite && (
            <Button type="button" size="sm" onClick={startNew} className="ml-auto">
              <Plus className="h-4 w-4" />
              New
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between">
          <ListCount shown={matched.length} total={entries.length} noun="guideline" />
        </div>

        <div className="overflow-hidden rounded-md border">
          <ListPager {...paged} onPage={paged.setPage} position="top" />
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : loadError ? (
            <p className="px-3 py-6 text-center text-sm text-destructive">{loadError}</p>
          ) : paged.pageItems.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {entries.length === 0
                ? canWrite
                  ? 'No guidelines yet. Add one to record a convention.'
                  : 'No guidelines yet.'
                : 'Nothing matches.'}
            </p>
          ) : (
            paged.pageItems.map((entry) => (
              <GuidelineRow
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedId && !editing}
                onSelect={(id) => {
                  setDraft(null);
                  setSelectedId(id);
                }}
              />
            ))
          )}
          <ListPager {...paged} onPage={paged.setPage} />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor="guideline-title">
                Title
              </label>
              <Input
                id="guideline-title"
                value={draft.title}
                maxLength={100}
                spellCheck={false}
                placeholder="Glossing conventions"
                aria-describedby={titleTaken ? 'guideline-title-taken' : undefined}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              {titleTaken && (
                <p id="guideline-title-taken" className="text-xs text-muted-foreground">
                  Another guideline has this title.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium" htmlFor="guideline-summary">
                Summary
              </label>
              <Input
                id="guideline-summary"
                value={draft.summary}
                maxLength={200}
                placeholder="What this guideline covers, in one line."
                onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              />
            </div>
            <Suspended>
              <GuidelineEditor
                value={draft.body}
                disabled={saving}
                onChange={(body) => setDraft((d) => ({ ...d, body }))}
              />
            </Suspended>
            <div className="flex items-center gap-2">
              <Button type="button" onClick={save} disabled={saving}>
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : opened ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-lg font-semibold">
                  {opened.pinned && <Pin className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  {opened.title}
                </h2>
                <p className="text-sm text-muted-foreground">{opened.summary}</p>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={togglePinned}
                    title={opened.pinned ? 'Unpin' : 'Always send to the assistant'}
                    aria-label={opened.pinned ? 'Unpin' : 'Pin'}
                  >
                    {opened.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={startEdit}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={remove}
                    title="Delete"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            {opened.body ? (
              <SafeMarkdown className="max-w-3xl">{opened.body}</SafeMarkdown>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing written yet.</p>
            )}
          </div>
        ) : (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            {entries.length === 0 ? '' : 'Open a guideline to read it.'}
          </p>
        )}
      </div>
    </div>
  );
}
