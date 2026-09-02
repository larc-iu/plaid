import { useDeferredValue, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Sparkles, AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { pageSlice } from '@/hooks/usePagedList';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@/components/shared/ConfirmDeleteDialog';
import {
  MODES,
  RESERVED_VALUE_KEYS,
  TAGSET_MODES,
  missingAffixDelimiters,
  scanValue,
  stripSpace,
  unreachableValues,
  seedCandidates,
} from '@/domain/tagsets';

// The editor for a project's tagsets. Owns a draft of the whole map and hands
// the whole map back on every discrete change (add/delete/toggle) or on blur
// for the text inputs, so a rename does not write once per keystroke.
// `onSaveChanges(next, meta)` gets `meta.renamed = { from, to }` on a rename,
// because fields reference a tagset by NAME and the wrapper has to repoint
// them in the same operation.
//
// `usage` maps a tagset name to the fields referencing it (governedFields
// records), which is what makes a delete safe to reason about and a rename
// able to say what it repointed. `onLoadAttested(name)` returns the
// [value, count] rows actually present in those fields, for the seed.

const SAMPLE = '1SG.NOM';

// A seeded Leipzig tagset runs to well over a thousand values, so the table is
// searched and paged rather than rendered whole. Smaller than the app's usual
// page: a value row is an expandable editor, not a line of text.
export const VALUE_PAGE_SIZE = 25;

// How each mode presents itself. The help text is the whole explanation a user
// gets: what can be entered, and which kind of field it suits. Nothing else.
const MODES_UI = {
  [MODES.SUGGEST]: {
    // "Open" against "Closed", the way a linguist already reads open and
    // closed classes. The stored mode value is still `suggest`.
    label: 'Open',
    badge: 'border-transparent bg-slate-100 text-slate-700',
    help: 'The whole list is offered while you annotate, but anything can be typed.',
  },
  [MODES.CLOSED]: {
    label: 'Closed',
    badge: 'border-transparent bg-amber-100 text-amber-800',
    help: 'Only tags in the list can be entered. For a fixed inventory such as part of speech.',
  },
  [MODES.MIXED]: {
    label: 'Closed, plus lexical glosses',
    badge: 'border-transparent bg-indigo-100 text-indigo-800',
    help: 'Any tag with at least one lowercase letter is allowed, but a tag with no lowercase letter is invalid unless it is on the list. Useful for glosses.',
  },
};

// Everything on a value record that isn't a reserved key: free-form data the
// project hung off the tag, which this app preserves and shows but never
// interprets.
const extraKeys = (rec) =>
  Object.keys(rec).filter((k) => k !== 'value' && !RESERVED_VALUE_KEYS.includes(k));

export const TagsetsManager = ({ tagsets, usage, onSaveChanges, onLoadAttested }) => {
  const [draft, setDraft] = useState(tagsets);
  const [openName, setOpenName] = useState(null);
  const [expandedValue, setExpandedValue] = useState(null);
  const [newTagsetName, setNewTagsetName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [valueQuery, setValueQuery] = useState('');
  // The input stays instant; the table is allowed to lag behind it. A fixed
  // debounce would be the wrong tool here — filtering 1,700 strings costs
  // nothing, the re-render of the rows is the only cost, and a timeout would
  // add latency on every keystroke whether or not it was needed. This defers
  // exactly when React is actually behind, and not at all when it is not.
  const deferredQuery = useDeferredValue(valueQuery);
  const [valuePage, setValuePage] = useState(0);
  const [pendingDelete, setPendingDelete] = useState(null);
  // A seed waiting on a decision: { name, tags, lexical } (see seedCandidates).
  const [seedPending, setSeedPending] = useState(null);

  const save = async (next, meta) => {
    setDraft(next);
    try {
      await onSaveChanges(next, meta);
      return true;
    } catch {
      // The settings wrapper reports it; roll the draft back so what's on
      // screen is what the server has.
      setDraft(tagsets);
      return false;
    }
  };

  const patch = (name, changes) => save({ ...draft, [name]: { ...draft[name], ...changes } });

  const handleAddTagset = async () => {
    const name = newTagsetName.trim();
    if (!name) return;
    if (draft[name]) {
      notifyError(`A tagset named "${name}" already exists`, 'Duplicate Tagset');
      return;
    }
    await save({ ...draft, [name]: { delimiters: '', mode: MODES.SUGGEST, values: [] } });
    setNewTagsetName('');
    setOpenName(name);
    notifySuccess(`"${name}" has been created`, 'Tagset Added');
  };

  const handleRenameTagset = async (from, to) => {
    const name = to.trim();
    if (!name || name === from) return;
    if (draft[name]) {
      notifyError(`A tagset named "${name}" already exists`, 'Duplicate Tagset');
      return;
    }
    // Object order is the display order, so rebuild in place rather than
    // deleting and appending (a rename shouldn't move the row to the bottom).
    const next = {};
    for (const [k, v] of Object.entries(draft)) next[k === from ? name : k] = v;
    // Fields point at a tagset BY NAME, so the save carries the rename along
    // and the wrapper repoints every field that used the old name in the same
    // operation. Left to the user, they all silently fell back to free.
    if (!(await save(next, { renamed: { from, to: name } }))) return;
    setOpenName(name);
    const fields = usage?.[from] || [];
    if (fields.length) {
      notifyInfo(
        `${fields.length} field${fields.length === 1 ? '' : 's'} now use${fields.length === 1 ? 's' : ''} "${name}"`,
        'Tagset Renamed',
      );
    }
  };

  const handleDeleteTagset = async (name) => {
    const next = { ...draft };
    delete next[name];
    await save(next);
    if (openName === name) setOpenName(null);
    notifyInfo(`"${name}" has been removed`, 'Tagset Removed');
  };

  const handleAddValues = async (name, records) => {
    const t = draft[name];
    const have = new Set(t.values.map((v) => v.value));
    const fresh = records.filter((r) => r.value && !have.has(r.value));
    if (!fresh.length) {
      // Two different nothings: nothing was found, or everything found is
      // already here. Saying the second when the first happened sends people
      // looking for a bug in the wrong place.
      notifyInfo(
        records.length ? 'Every value found is already in the tagset' : 'No values found',
        'Nothing to Add',
      );
      return 0;
    }
    await patch(name, { values: [...t.values, ...fresh] });
    return fresh.length;
  };

  const seedWith = async (name, records) => {
    setSeedPending(null);
    const n = await handleAddValues(name, records);
    if (n) notifySuccess(`Added ${n} value${n === 1 ? '' : 's'} found in this project`, 'Seeded');
  };

  // The attested rows are per-tagset (they come from the fields referencing it),
  // so this is never cached across tagsets.
  const handleSeedAttested = async (name) => {
    try {
      const rows = await onLoadAttested(name);
      const { tags, lexical } = seedCandidates(rows, draft[name]);
      // Lowercase values wait on a decision (see seedCandidates): in a glossed
      // project they are the stems, and there are far more of them than tags.
      // Seeding them unasked is how a tagset came to hold 1,700 values.
      // Nothing to decide when there are none.
      if (!lexical.length) {
        await seedWith(name, tags);
        return;
      }
      setSeedPending({ name, tags, lexical });
    } catch (error) {
      console.error('Failed to read attested values:', error);
      notifyError('Could not read the values already used in this project', 'Seed Failed');
    }
  };

  const handlePaste = async (name) => {
    const records = pasteText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => ({ value }));
    const n = await handleAddValues(name, records);
    if (n) notifySuccess(`Added ${n} value${n === 1 ? '' : 's'}`, 'Values Added');
    setPasteText('');
    setPasteOpen(false);
  };

  // Returns false when the change is refused, so the row can reset its input.
  const patchValue = (name, index, changes) => {
    // A renamed value must stay unique: the duplicate would be dropped on the
    // next read (normalizeTagset keeps the first), taking its description
    // with it.
    if (
      changes.value !== undefined &&
      draft[name].values.some((v, i) => i !== index && v.value === changes.value)
    ) {
      notifyError(`"${changes.value}" is already in the tagset`, 'Duplicate Value');
      return false;
    }
    const values = draft[name].values.map((v, i) => (i === index ? { ...v, ...changes } : v));
    return patch(name, { values });
  };

  // Wholesale replacement, for removing a custom field: a merge-patch can add
  // and change keys but never delete one.
  const replaceValue = (name, index, rec) => {
    const values = draft[name].values.map((v, i) => (i === index ? rec : v));
    return patch(name, { values });
  };

  const removeValue = (name, index) =>
    patch(name, { values: draft[name].values.filter((_, i) => i !== index) });

  const names = Object.keys(draft);

  return (
    <div className="flex flex-col gap-4">
      {names.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No tagsets yet. Add one, then assign it to a field under Annotation Fields.
        </p>
      )}

      {names.map((name) => {
        const t = draft[name];
        const isOpen = openName === name;
        const fields = usage?.[name] || [];
        const preview = scanValue(SAMPLE, t.delimiters);
        // A word-scope gloss reads "dog-PL". If "-" is not a delimiter, mixed
        // mode waves the whole thing through on the lowercase in "dog".
        // A value holding one of its own delimiters is scanned as two parts and
        // can never match, so the list would hold something it rejects.
        const unreachable = unreachableValues(t);
        const missingAffix = missingAffixDelimiters(
          t,
          fields.some((f) => f.scope === 'word'),
        );
        return (
          <div key={name} className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-2 px-3 py-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => {
                  setOpenName(isOpen ? null : name);
                  setValueQuery('');
                  setValuePage(0);
                  setSeedPending(null);
                }}
                title={isOpen ? 'Collapse' : 'Expand'}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
              <span className="font-medium">{name}</span>
              <Badge variant="secondary" className={MODES_UI[t.mode].badge}>
                {MODES_UI[t.mode].label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t.values.length} value{t.values.length === 1 ? '' : 's'}
                {t.delimiters && ` · split on ${[...t.delimiters].join(' ')}`}
                {fields.length > 0 &&
                  ` · used by ${fields.map((f) => `${f.field} (${f.scope})`).join(', ')}`}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => setPendingDelete(name)}
                title="Delete tagset"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {isOpen && (
              <div className="flex flex-col gap-5 border-t bg-muted/20 px-3 py-4">
                {/* Name */}
                <div className="flex max-w-md flex-col gap-1">
                  <p className="text-sm font-medium">Name</p>
                  <Input
                    defaultValue={name}
                    onBlur={(e) => handleRenameTagset(name, e.currentTarget.value)}
                  />
                </div>

                {/* How strictly the list governs. One control, because the
                    three answers are points on a line rather than independent
                    switches. */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">How the list is applied</p>
                  {TAGSET_MODES.map((m) => (
                    <label key={m} className="flex max-w-2xl items-start gap-3">
                      <input
                        type="radio"
                        name={`tagset-mode-${name}`}
                        className="mt-1"
                        checked={t.mode === m}
                        onChange={() => patch(name, { mode: m })}
                      />
                      <span>
                        <span className="text-sm font-medium">{MODES_UI[m].label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {MODES_UI[m].help}
                        </span>
                      </span>
                    </label>
                  ))}
                  <p className="max-w-2xl text-xs text-muted-foreground">
                    Closed lists apply to what you type. Values brought in by imports, services or
                    the assistant are not checked; the Validation tab finds them.
                  </p>
                </div>

                {/* Delimiters */}
                <div className="flex max-w-2xl flex-col gap-1">
                  <p className="text-sm font-medium">Delimiters</p>
                  <p className="text-xs text-muted-foreground">
                    Characters that separate tags within one cell, so each tag is checked on its
                    own. Leave empty if a cell holds a single tag, as for part of speech.
                  </p>
                  <Input
                    className="max-w-[12rem] font-mono"
                    placeholder="e.g. .:>"
                    // Uncontrolled, so it must remount when the value changes
                    // from outside (the affix quick-fix below), or the stale
                    // display gets written back on the next blur.
                    key={t.delimiters}
                    defaultValue={t.delimiters}
                    onBlur={(e) => {
                      // Spaces are never delimiters (see normalizeTagset).
                      const next = stripSpace(e.currentTarget.value);
                      if (next !== t.delimiters) patch(name, { delimiters: next });
                      else e.currentTarget.value = t.delimiters;
                    }}
                  />
                  {missingAffix.length > 0 && (
                    <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div>
                        A Word field uses this tagset. Word glosses join tags with{' '}
                        {missingAffix.map((d) => (
                          <span key={d} className="font-mono">
                            {d}{' '}
                          </span>
                        ))}
                        as in <span className="font-mono">dog-PL</span>, so add{' '}
                        {missingAffix.length === 1 ? 'it as a delimiter' : 'them as delimiters'} or{' '}
                        <span className="font-mono">PL</span> is never checked.
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-2 h-6"
                          onClick={() =>
                            patch(name, { delimiters: t.delimiters + missingAffix.join('') })
                          }
                        >
                          Add {missingAffix.join(' and ')}
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-mono">{SAMPLE}</span> is checked as{' '}
                    {preview.map((p, i) => (
                      <span key={i}>
                        {i > 0 && ' + '}
                        <span className="rounded bg-background px-1 font-mono">
                          {p.text || '(empty)'}
                        </span>
                      </span>
                    ))}
                  </p>
                </div>

                {/* Values */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Values</p>
                  {unreachable.length > 0 && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <div>
                        {unreachable.map((v) => (
                          <span key={v.value} className="font-mono">
                            {v.value}{' '}
                          </span>
                        ))}
                        {unreachable.length === 1 ? 'contains' : 'contain'} a delimiter, so{' '}
                        {unreachable.length === 1 ? 'it' : 'they'} can never match. Remove it from
                        the value or from the delimiters.
                      </div>
                    </div>
                  )}
                  {t.values.length > 0 &&
                    (() => {
                      const q = deferredQuery.trim().toLowerCase();
                      const matched = t.values
                        .map((rec, i) => ({ rec, i }))
                        .filter(
                          ({ rec }) =>
                            !q ||
                            rec.value.toLowerCase().includes(q) ||
                            String(rec.description ?? '')
                              .toLowerCase()
                              .includes(q),
                        );
                      const paged = pageSlice(matched, valuePage, VALUE_PAGE_SIZE);
                      return (
                        <>
                          <div className="flex items-center gap-2">
                            <SearchInput
                              className="w-full max-w-[18rem]"
                              inputClassName="h-8"
                              placeholder="Search values…"
                              value={valueQuery}
                              onChange={(v) => {
                                setValueQuery(v);
                                setValuePage(0);
                              }}
                            />
                            <ListCount
                              shown={matched.length}
                              total={t.values.length}
                              noun="value"
                            />
                          </div>
                          {paged.pageItems.length === 0 ? (
                            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                              No values match “{deferredQuery}”.
                            </p>
                          ) : (
                            <div className="overflow-hidden rounded-md border bg-background">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-xs text-muted-foreground">
                                    <th className="w-8 px-2 py-1.5"></th>
                                    <th className="w-[22%] px-2 py-1.5 text-left font-medium">
                                      Value
                                    </th>
                                    <th className="px-2 py-1.5 text-left font-medium">
                                      Description
                                    </th>
                                    <th className="w-24 px-2 py-1.5 text-left font-medium">
                                      Color
                                    </th>
                                    <th className="w-8 px-2 py-1.5"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {paged.pageItems.map(({ rec, i }) => {
                                    // Keyed by value, not position: the row's
                                    // inputs are uncontrolled, and an index
                                    // key hands a row's DOM node, text and
                                    // all, to whichever record slides into
                                    // its slot after a removal.
                                    const key = `${name}:${rec.value}`;
                                    const extras = extraKeys(rec);
                                    return (
                                      <ValueRow
                                        key={key}
                                        rec={rec}
                                        extras={extras}
                                        expanded={expandedValue === key}
                                        onToggle={() =>
                                          setExpandedValue(expandedValue === key ? null : key)
                                        }
                                        onPatch={(changes) => patchValue(name, i, changes)}
                                        onReplace={(next) => replaceValue(name, i, next)}
                                        onRemove={() => removeValue(name, i)}
                                      />
                                    );
                                  })}
                                </tbody>
                              </table>
                              <ListPager {...paged} onPage={setValuePage} />
                            </div>
                          )}
                        </>
                      );
                    })()}

                  {/* Add one */}
                  <div className="flex items-center gap-2">
                    <Input
                      className="max-w-[16rem]"
                      placeholder="Add a value"
                      value={newValue}
                      onChange={(e) => setNewValue(e.currentTarget.value)}
                      onKeyDown={async (e) => {
                        if (e.key !== 'Enter') return;
                        const v = newValue.trim();
                        if (!v) return;
                        await handleAddValues(name, [{ value: v }]);
                        setNewValue('');
                      }}
                    />
                    <Button
                      variant="outline"
                      disabled={!newValue.trim()}
                      onClick={async () => {
                        await handleAddValues(name, [{ value: newValue.trim() }]);
                        setNewValue('');
                      }}
                    >
                      <Plus className="h-4 w-4" /> Add
                    </Button>
                    <Button variant="ghost" onClick={() => setPasteOpen((o) => !o)}>
                      Paste a list
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={fields.length === 0}
                      onClick={() => handleSeedAttested(name)}
                      title={
                        fields.length === 0
                          ? 'Assign this tagset to a field first.'
                          : `Add every tag already used in ${fields.map((f) => f.field).join(', ')}`
                      }
                    >
                      <Sparkles className="h-4 w-4" /> Add values used in this project
                    </Button>
                  </div>

                  {pasteOpen && (
                    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <p className="text-xs text-muted-foreground">
                        One value per line, or comma separated. Values already in the list are
                        skipped.
                      </p>
                      <Textarea
                        rows={4}
                        className="font-mono text-sm"
                        value={pasteText}
                        onChange={(e) => setPasteText(e.currentTarget.value)}
                        placeholder={'NOM\nACC\nERG'}
                      />
                      <div className="flex gap-2">
                        <Button disabled={!pasteText.trim()} onClick={() => handlePaste(name)}>
                          Add values
                        </Button>
                        <Button variant="ghost" onClick={() => setPasteOpen(false)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {seedPending?.name === name && (
                    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <p className="text-sm">
                        Found <strong>{seedPending.tags.length}</strong> tag
                        {seedPending.tags.length === 1 ? '' : 's'} and{' '}
                        <strong>{seedPending.lexical.length}</strong> lowercase value
                        {seedPending.lexical.length === 1 ? '' : 's'} (
                        <span className="font-mono">
                          {seedPending.lexical
                            .slice(0, 5)
                            .map((v) => v.value)
                            .join(', ')}
                        </span>
                        {seedPending.lexical.length > 5 ? ', …' : ''}) not in the list.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        In a Gloss field, lowercase values are usually stems rather than tags.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          disabled={seedPending.tags.length === 0}
                          onClick={() => seedWith(name, seedPending.tags)}
                        >
                          Add {seedPending.tags.length} tag
                          {seedPending.tags.length === 1 ? '' : 's'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() =>
                            seedWith(name, [...seedPending.tags, ...seedPending.lexical])
                          }
                        >
                          Add all {seedPending.tags.length + seedPending.lexical.length}
                        </Button>
                        <Button variant="ghost" onClick={() => setSeedPending(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Add a tagset */}
      <div className="flex items-center gap-2">
        <Input
          className="max-w-[20rem]"
          placeholder="New tagset name (e.g. Leipzig)"
          value={newTagsetName}
          onChange={(e) => setNewTagsetName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddTagset()}
        />
        <Button onClick={handleAddTagset} disabled={!newTagsetName.trim()}>
          <Plus className="h-4 w-4" /> Add Tagset
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="Delete Tagset"
        confirmLabel="Delete Tagset"
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (name) handleDeleteTagset(name);
        }}
      >
        <p className="font-medium text-destructive">Warning</p>
        <p className="mt-1 text-muted-foreground">
          You are about to delete the tagset <strong>"{pendingDelete}"</strong>.
        </p>
        <p className="mt-1 text-muted-foreground">
          {(usage?.[pendingDelete] || []).length === 0
            ? 'No field uses it.'
            : `${usage[pendingDelete].map((f) => `${f.field} (${f.scope})`).join(', ')} ${usage[pendingDelete].length === 1 ? 'uses' : 'use'} it and will accept any value again. No annotations are changed.`}
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};

// One value row. The reserved keys (description, color) are edited inline
// because they are what almost every tagset uses; anything else the project
// hangs off the tag lives behind the expander, preserved verbatim.
const ValueRow = ({ rec, extras, expanded, onToggle, onPatch, onReplace, onRemove }) => {
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const addExtra = () => {
    const k = newKey.trim();
    if (!k || k === 'value' || RESERVED_VALUE_KEYS.includes(k)) return;
    onPatch({ [k]: newVal });
    setNewKey('');
    setNewVal('');
  };

  return (
    <>
      <tr className="border-t align-middle">
        <td className="px-2 py-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onToggle}
            title={extras.length ? `${extras.length} more field(s)` : 'Add custom fields'}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight
                className={`h-3.5 w-3.5 ${extras.length ? '' : 'text-muted-foreground/40'}`}
              />
            )}
          </Button>
        </td>
        <td className="px-2 py-1">
          <Input
            className="h-7 font-mono"
            defaultValue={rec.value}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== rec.value && onPatch({ value: v }) !== false) return;
              e.currentTarget.value = rec.value;
            }}
          />
        </td>
        <td className="px-2 py-1">
          <Input
            className="h-7"
            defaultValue={rec.description ?? ''}
            onBlur={(e) => {
              const next = e.currentTarget.value;
              if (next !== (rec.description ?? '')) onPatch({ description: next });
            }}
          />
        </td>
        <td className="px-2 py-1">
          <input
            type="color"
            className="h-7 w-full cursor-pointer rounded border bg-background"
            value={rec.color ?? '#cccccc'}
            onChange={(e) => onPatch({ color: e.currentTarget.value })}
            title="Color"
          />
        </td>
        <td className="px-2 py-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove value"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-muted/30">
          <td></td>
          <td colSpan={4} className="px-2 py-2">
            {extras.map((k) => (
              <div key={k} className="mb-1 flex items-center gap-2">
                <span className="w-32 shrink-0 truncate font-mono text-xs">{k}</span>
                <Input
                  className="h-7 max-w-md"
                  defaultValue={String(rec[k] ?? '')}
                  onBlur={(e) => {
                    const next = e.currentTarget.value;
                    if (next !== String(rec[k] ?? '')) onPatch({ [k]: next });
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    const next = { ...rec };
                    delete next[k];
                    onReplace(next);
                  }}
                  title="Remove field"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <Input
                className="h-7 w-32 font-mono"
                placeholder="key"
                value={newKey}
                onChange={(e) => setNewKey(e.currentTarget.value)}
              />
              <Input
                className="h-7 max-w-md"
                placeholder="value"
                value={newVal}
                onChange={(e) => setNewVal(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Enter' && addExtra()}
              />
              <Button size="sm" variant="outline" disabled={!newKey.trim()} onClick={addExtra}>
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};
