import { useDeferredValue, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@ui/components/shared/list-search';
import { pageSlice, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { Textarea } from '@ui/components/ui/textarea';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { RefusedValuesNotice } from './RefusedValuesNotice.jsx';
import { REFUSED_TITLE, refusedValuesText } from './refusedValues.js';
import {
  MODES,
  RESERVED_VALUE_KEYS,
  TAGSET_MODES,
  compareValues,
  missingAffixDelimiters,
  scanValue,
  sortedValues,
  stripSpace,
  unreachableValues,
  seedCandidates,
} from '@/domain/tagsets';
import { textIncludes } from '@ui/domain/collation.js';
import { sameConfig } from '@ui/domain/configCells.js';
import { nameKey } from '@ui/lib/nameKey.js';
import { t, tx, msg, listOf } from '@ui/lib/i18n.js';
import { isEnter } from '@ui/lib/chords.js';

// The editor for a project's tagsets. Owns a draft of the whole map and hands
// the whole map back on every discrete change (add/delete/toggle) or on blur
// for the text inputs, so a rename does not write once per keystroke.
// `onSaveChanges(next, meta)` gets `meta.renamed = { from, to }` on a rename,
// because fields reference a tagset by NAME and the wrapper has to repoint
// them in the same operation. It may answer `{repointed}`, how many fields
// the rename repointed as the save read them.
//
// `usage` maps a tagset name to the fields referencing it (governedFields
// records), which is what makes a delete safe to reason about and a rename
// able to say what it repointed. `onLoadAttested(name)` returns the
// [value, count] rows actually present in those fields, for the seed.

const SAMPLE = '1SG.NOM';

// A seeded Leipzig tagset runs to well over a thousand values, so the table is
// searched and paged rather than rendered whole. Smaller than the app's usual
// page: a value row is an expandable editor, not a line of text. Re-exported
// under a local name because the tests address it that way.
export const VALUE_PAGE_SIZE = TALL_LIST_PAGE_SIZE;

// How each mode presents itself. The help text is the whole explanation a user
// gets: what can be entered, and which kind of field it suits. Nothing else.
const MODES_UI = {
  [MODES.SUGGEST]: {
    // "Open" against "Closed", the way a linguist already reads open and
    // closed classes. The stored mode value is still `suggest`.
    label: msg('Open'),
    badge: 'border-transparent bg-secondary text-secondary-foreground',
    help: msg('The whole list is offered while you annotate, but anything can be typed.'),
  },
  [MODES.CLOSED]: {
    label: msg('Closed'),
    // Neutral: amber means a contributor's unreviewed work.
    badge: 'border-input bg-transparent text-foreground',
    help: msg(
      'Only tags in the list can be entered. For a fixed inventory such as part of speech.',
    ),
  },
  [MODES.MIXED]: {
    label: msg('Closed, plus lexical glosses'),
    badge: 'border-dashed border-input bg-transparent text-foreground',
    help: msg(
      'A tag is allowed if it has a lowercase letter or is in a script without capitals. Anything else must be on the list. Useful for glosses.',
    ),
  },
};

// Everything on a value record that isn't a reserved key: free-form data the
// project hung off the tag, which this app preserves and shows but never
// interprets.
const extraKeys = (rec) =>
  Object.keys(rec).filter((k) => k !== 'value' && !RESERVED_VALUE_KEYS.includes(k));

// A field that uses a tagset, with its scope: "Gloss (word)".
const fieldWithScope = (f) =>
  t(
    '{field} ({scope, select, sentence {sentence} word {word} morpheme {morpheme} other {{scope}}})',
    { field: f.field, scope: String(f.scope) },
  );

const mono = (c) => <span className="font-mono">{c}</span>;

export const TagsetsManager = ({
  tagsets,
  usage,
  onSaveChanges,
  onLoadAttested,
  // The wording that differs between a project's tagsets and a vocabulary's:
  // where a field gets assigned, what the seed reads, what a delete leaves
  // alone.
  emptyHint = t('No tagsets yet. Add one, then assign it to a field under Annotation fields.'),
  seedLabel = t('Add values used in this project'),
  // What a delete leaves alone, as a whole sentence. `valuesNoun` is the old
  // bare-noun form of it, kept for callers not yet moved to `keptNote`.
  valuesNoun,
  keptNote = valuesNoun
    ? `No ${valuesNoun} are changed.` // i18n-ignore: the old bare-noun prop, English only until its caller passes keptNote
    : t('No annotations are changed.'),
  enforceNote = t(
    'Closed lists apply to what you type and to the assistant. Values brought in by imports or services are not checked. The Validation tab lists them.',
  ),
  // {tagset name: [value]}: values that may not be renamed or removed, and
  // what a refusal of one says, given the value (a vocabulary's reserved
  // Status values).
  reservedValues = {},
  reservedMessage = () => t('This value is reserved and cannot be renamed or removed'),
}) => {
  const [draft, setDraft] = useState(tagsets);
  // The tagsets as the page last read them. A read that brings something new
  // (another maintainer's save) replaces the draft, so the next change is
  // made to what is stored now and not written over it.
  const [seen, setSeen] = useState(tagsets);
  if (seen !== tagsets && !sameConfig(seen, tagsets)) {
    setSeen(tagsets);
    setDraft(tagsets);
  }
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
  // A change to the tagset `name` not saved because values in use are not in
  // its closed list: { name, fields } (`refusedValues` of the rejection).
  const [refused, setRefused] = useState(null);

  const save = async (next, meta, name) => {
    setDraft(next);
    try {
      const saved = await onSaveChanges(next, meta);
      setRefused(null);
      return saved ?? true;
    } catch (error) {
      // The settings wrapper reports it; roll the draft back so what's on
      // screen is what the server has. Values in the way of a closed list
      // are shown in the panel of the tagset changed, and as a toast when
      // the change was made outside one (an add, a rename, a delete).
      setDraft(tagsets);
      if (error?.refusedValues) {
        if (name) setRefused({ name, fields: error.refusedValues });
        else {
          setRefused(null);
          notifyError(refusedValuesText(error.refusedValues), t(REFUSED_TITLE));
        }
      }
      return false;
    }
  };

  const patch = (name, changes) =>
    save({ ...draft, [name]: { ...draft[name], ...changes } }, undefined, name);

  const handleAddTagset = async () => {
    // composed, as the server stores the name, so a name typed in another
    // spelling finds the tagset it names
    const name = nameKey(newTagsetName).trim();
    if (!name) return;
    if (draft[name]) {
      notifyError(t('A tagset named "{name}" already exists', { name }), t('Duplicate tagset'));
      return;
    }
    if (!(await save({ ...draft, [name]: { delimiters: '', mode: MODES.SUGGEST, values: [] } })))
      return;
    setNewTagsetName('');
    setOpenName(name);
    notifySuccess(t('Tagset “{name}” added', { name }));
  };

  const handleRenameTagset = async (from, to) => {
    const name = nameKey(to).trim();
    if (!name || name === from) return;
    if (draft[name]) {
      notifyError(t('A tagset named "{name}" already exists', { name }), t('Duplicate tagset'));
      return;
    }
    // Object order is the display order, so rebuild in place rather than
    // deleting and appending (a rename shouldn't move the row to the bottom).
    const next = {};
    for (const [k, v] of Object.entries(draft)) next[k === from ? name : k] = v;
    // Fields point at a tagset BY NAME, so the save carries the rename along
    // and the wrapper repoints every field that used the old name in the same
    // operation. Left to the user, they all silently fell back to free.
    const saved = await save(next, { renamed: { from, to: name } });
    if (!saved) return;
    setOpenName(name);
    // The fields the save repointed, read when it saved, else the ones this
    // page knows.
    const n = saved.repointed ?? (usage?.[from] || []).length;
    if (n) {
      notifyInfo(
        t('{n, plural, one {# field now uses} other {# fields now use}} "{name}"', { n, name }),
        t('Tagset renamed'),
      );
    }
  };

  const handleDeleteTagset = async (name) => {
    const next = { ...draft };
    delete next[name];
    if (!(await save(next))) return;
    if (openName === name) setOpenName(null);
    notifyInfo(t('Tagset “{name}” removed', { name }));
  };

  const handleAddValues = async (name, records) => {
    const tagset = draft[name];
    const have = new Set(tagset.values.map((v) => v.value));
    const fresh = records.filter((r) => r.value && !have.has(r.value));
    if (!fresh.length) {
      // Two different nothings: nothing was found, or everything found is
      // already here. Saying the second when the first happened sends people
      // looking for a bug in the wrong place.
      notifyInfo(
        records.length ? t('Every value found is already in the tagset') : t('No values found'),
        t('Nothing to add'),
      );
      return 0;
    }
    const values = [...tagset.values, ...fresh];
    // Refused: null, and what was pasted stays to be added again.
    if (!(await patch(name, { values }))) return null;
    // The table reads in alphabetical order, so one added value lands
    // somewhere in the middle: show the page it landed on rather than leaving
    // it out of sight.
    if (fresh.length === 1) {
      const at = sortedValues({ values }).findIndex((v) => v.value === fresh[0].value);
      setValueQuery('');
      setValuePage(Math.floor(at / VALUE_PAGE_SIZE));
    }
    return fresh.length;
  };

  const seedWith = async (name, records) => {
    setSeedPending(null);
    const n = await handleAddValues(name, records);
    if (n) {
      notifySuccess(
        t('Added {n, plural, one {# value} other {# values}} found in this project', { n }),
      );
    }
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
      notifyError(error, t('Failed to read the values used in this project'));
    }
  };

  const handlePaste = async (name) => {
    const records = pasteText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => ({ value }));
    const n = await handleAddValues(name, records);
    if (n === null) return;
    if (n) notifySuccess(t('Added {n, plural, one {# value} other {# values}}', { n }));
    setPasteText('');
    setPasteOpen(false);
  };

  const isReserved = (name, value) => (reservedValues[name] || []).includes(value);
  const refuseReserved = (value) => {
    notifyError(reservedMessage(value), t('Reserved value'));
    return false;
  };

  // Returns false when the change is refused, so the row can reset its input.
  const patchValue = (name, index, changes) => {
    if (
      changes.value !== undefined &&
      changes.value !== draft[name].values[index]?.value &&
      isReserved(name, draft[name].values[index]?.value)
    ) {
      return refuseReserved(draft[name].values[index].value);
    }
    // A renamed value must stay unique: the duplicate would be dropped on the
    // next read (normalizeTagset keeps the first), taking its description
    // with it.
    if (
      changes.value !== undefined &&
      draft[name].values.some((v, i) => i !== index && v.value === changes.value)
    ) {
      notifyError(
        t('"{value}" is already in the tagset', { value: changes.value }),
        t('Duplicate value'),
      );
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
    isReserved(name, draft[name].values[index]?.value)
      ? refuseReserved(draft[name].values[index].value)
      : patch(name, { values: draft[name].values.filter((_, i) => i !== index) });

  const names = Object.keys(draft);

  return (
    <div className="flex flex-col gap-4">
      {names.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {emptyHint}
        </p>
      )}

      {names.map((name) => {
        const ts = draft[name];
        const isOpen = openName === name;
        const fields = usage?.[name] || [];
        const preview = scanValue(SAMPLE, ts.delimiters);
        // A word-scope gloss reads "dog-PL". If "-" is not a delimiter, mixed
        // mode waves the whole thing through on the lowercase in "dog".
        // A value holding one of its own delimiters is scanned as two parts and
        // can never match, so the list would hold something it rejects.
        const unreachable = unreachableValues(ts);
        const missingAffix = missingAffixDelimiters(
          ts,
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
                title={isOpen ? t('Collapse') : t('Expand')}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
              <span className="font-medium">{name}</span>
              <Badge variant="secondary" className={MODES_UI[ts.mode].badge}>
                {t(MODES_UI[ts.mode].label)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {[
                  t('{n, plural, one {# value} other {# values}}', { n: ts.values.length }),
                  ts.delimiters &&
                    t('split on {delimiters}', { delimiters: [...ts.delimiters].join(' ') }),
                  fields.length > 0 &&
                    t('used by {fields}', { fields: fields.map(fieldWithScope).join(', ') }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => setPendingDelete(name)}
                title={t('Delete tagset')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {isOpen && (
              <div className="flex flex-col gap-5 border-t bg-muted/20 px-3 py-4">
                {/* Name */}
                <div className="flex max-w-md flex-col gap-1">
                  <p className="text-sm font-medium">{t('Name')}</p>
                  <Input
                    defaultValue={name}
                    onBlur={(e) => handleRenameTagset(name, e.currentTarget.value)}
                  />
                </div>

                {/* How strictly the list governs. One control, because the
                    three answers are points on a line rather than independent
                    switches. */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t('How the list is applied')}</p>
                  {TAGSET_MODES.map((m) => (
                    <label key={m} className="flex max-w-2xl items-start gap-3">
                      <input
                        type="radio"
                        name={`tagset-mode-${name}`}
                        className="mt-1"
                        checked={ts.mode === m}
                        onChange={() => patch(name, { mode: m })}
                      />
                      <span>
                        <span className="text-sm font-medium">{t(MODES_UI[m].label)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(MODES_UI[m].help)}
                        </span>
                      </span>
                    </label>
                  ))}
                  <p className="max-w-2xl text-xs text-muted-foreground">{enforceNote}</p>
                  {refused?.name === name && (
                    <RefusedValuesNotice fields={refused.fields} className="max-w-2xl text-xs" />
                  )}
                </div>

                {/* Delimiters */}
                <div className="flex max-w-2xl flex-col gap-1">
                  <p className="text-sm font-medium">{t('Delimiters')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'Characters that separate tags within one cell, so each tag is checked on its own. Leave empty if a cell holds a single tag, as for part of speech.',
                    )}
                  </p>
                  <Input
                    className="max-w-[12rem] font-mono"
                    placeholder={t('e.g. {example}', { example: '.:>' })}
                    // Uncontrolled, so it must remount when the value changes
                    // from outside (the affix quick-fix below), or the stale
                    // display gets written back on the next blur.
                    key={ts.delimiters}
                    defaultValue={ts.delimiters}
                    onBlur={(e) => {
                      // Spaces are never delimiters (see normalizeTagset).
                      const next = stripSpace(e.currentTarget.value);
                      if (next !== ts.delimiters) patch(name, { delimiters: next });
                      else e.currentTarget.value = ts.delimiters;
                    }}
                  />
                  {missingAffix.length > 0 && (
                    <Notice tone="warning" className="mt-1 text-xs">
                      <div>
                        {tx(
                          'A Word field uses this tagset. Word glosses join tags with {delimiters} as in <mono>dog-PL</mono>, so add {n, plural, one {it as a delimiter} other {them as delimiters}} or <mono>PL</mono> is never checked.',
                          {
                            delimiters: missingAffix.map((d, i) => (
                              <span key={d}>
                                {i > 0 && ' '}
                                <span className="font-mono">{d}</span>
                              </span>
                            )),
                            n: missingAffix.length,
                            mono,
                          },
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-2 h-6"
                          onClick={() =>
                            patch(name, { delimiters: ts.delimiters + missingAffix.join('') })
                          }
                        >
                          {t('Add {delimiters}', { delimiters: listOf(missingAffix) })}
                        </Button>
                      </div>
                    </Notice>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tx('<mono>{sample}</mono> is checked as {parts}', {
                      sample: SAMPLE,
                      mono,
                      parts: preview.map((p, i) => (
                        <span key={i}>
                          {i > 0 && ' + '}
                          <span className="rounded-sm bg-background px-1 font-mono">
                            {p.text || t('(empty)')}
                          </span>
                        </span>
                      )),
                    })}
                  </p>
                </div>

                {/* Values */}
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{t('Values')}</p>
                  {unreachable.length > 0 && (
                    <Notice tone="warning" className="text-xs">
                      <div>
                        {tx(
                          '{values} {n, plural, one {contains a delimiter, so it can never match.} other {contain a delimiter, so they can never match.}} Remove it from the value or from the delimiters.',
                          {
                            values: unreachable.map((v, i) => (
                              <span key={v.value}>
                                {i > 0 && ' '}
                                <span className="font-mono">{v.value}</span>
                              </span>
                            )),
                            n: unreachable.length,
                          },
                        )}
                      </div>
                    </Notice>
                  )}
                  {ts.values.length > 0 &&
                    (() => {
                      const q = deferredQuery.trim().toLowerCase();
                      const matched = ts.values
                        .map((rec, i) => ({ rec, i }))
                        .filter(
                          ({ rec }) =>
                            !q ||
                            textIncludes(rec.value, q) ||
                            String(rec.description ?? '')
                              .toLowerCase()
                              .includes(q),
                        )
                        // Reading order. `i` still indexes the stored list,
                        // which is what the row's edits are applied to.
                        .sort((a, b) => compareValues(a.rec.value, b.rec.value));
                      const paged = pageSlice(matched, valuePage, VALUE_PAGE_SIZE);
                      return (
                        <>
                          <div className="flex items-center gap-2">
                            <ListCount
                              shown={matched.length}
                              total={ts.values.length}
                              noun="value"
                            />
                            <SearchInput
                              className="w-full max-w-[18rem]"
                              inputClassName="h-8"
                              placeholder={t('Search values…')}
                              value={valueQuery}
                              onChange={(v) => {
                                setValueQuery(v);
                                setValuePage(0);
                              }}
                            />
                          </div>
                          {paged.pageItems.length === 0 ? (
                            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                              {t('No values match “{query}”.', { query: deferredQuery })}
                            </p>
                          ) : (
                            <div className="overflow-hidden rounded-md border bg-background">
                              <ListPager {...paged} onPage={setValuePage} position="top" />
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-xs text-muted-foreground">
                                    <th className="w-8 px-2 py-1.5"></th>
                                    <th className="w-[22%] px-2 py-1.5 text-left font-medium">
                                      {t('Value')}
                                    </th>
                                    <th className="px-2 py-1.5 text-left font-medium">
                                      {t('Description')}
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
                                        reserved={isReserved(name, rec.value)}
                                        reservedMessage={reservedMessage}
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
                      placeholder={t('Add a value')}
                      value={newValue}
                      onChange={(e) => setNewValue(e.currentTarget.value)}
                      onKeyDown={async (e) => {
                        if (!isEnter(e)) return;
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
                      <Plus className="h-4 w-4" /> {t('Add')}
                    </Button>
                    <Button variant="ghost" onClick={() => setPasteOpen((o) => !o)}>
                      {t('Paste a list')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={fields.length === 0}
                      onClick={() => handleSeedAttested(name)}
                      title={
                        fields.length === 0
                          ? t('Assign this tagset to a field first.')
                          : t('Add every tag already used in {fields}', {
                              fields: fields.map((f) => f.field).join(', '),
                            })
                      }
                    >
                      <Sparkles className="h-4 w-4" /> {seedLabel}
                    </Button>
                  </div>

                  {pasteOpen && (
                    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'One value per line, or comma separated. Values already in the list are skipped.',
                        )}
                      </p>
                      <Textarea
                        rows={4}
                        className="font-mono text-sm"
                        value={pasteText}
                        onChange={(e) => setPasteText(e.currentTarget.value)}
                        placeholder={'NOM\nACC\nERG'} // i18n-ignore: example Leipzig tags
                      />
                      <div className="flex gap-2">
                        <Button disabled={!pasteText.trim()} onClick={() => handlePaste(name)}>
                          {t('Add values')}
                        </Button>
                        <Button variant="ghost" onClick={() => setPasteOpen(false)}>
                          {t('Cancel')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {seedPending?.name === name && (
                    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <p className="text-sm">
                        {tx(
                          'Found <strong>{tags}</strong> {tags, plural, one {tag} other {tags}} and <strong>{lexical}</strong> {lexical, plural, one {value} other {values}} not written in capitals (<mono>{examples}</mono>{more, select, yes {, …} other {}}) not in the list.',
                          {
                            tags: seedPending.tags.length,
                            lexical: seedPending.lexical.length,
                            examples: seedPending.lexical
                              .slice(0, 5)
                              .map((v) => v.value)
                              .join(', '),
                            more: seedPending.lexical.length > 5 ? 'yes' : 'no',
                            strong: (c) => <strong>{c}</strong>,
                            mono,
                          },
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('Read from {fields}.', {
                          fields: fields.map((f) => f.field).join(', '),
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          disabled={seedPending.tags.length === 0}
                          onClick={() => seedWith(name, seedPending.tags)}
                        >
                          {t('Add {n, plural, one {# tag} other {# tags}}', {
                            n: seedPending.tags.length,
                          })}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() =>
                            seedWith(name, [...seedPending.tags, ...seedPending.lexical])
                          }
                        >
                          {t('Add all {n}', {
                            n: seedPending.tags.length + seedPending.lexical.length,
                          })}
                        </Button>
                        <Button variant="ghost" onClick={() => setSeedPending(null)}>
                          {t('Cancel')}
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
          placeholder={t('New tagset name (e.g. Leipzig)')}
          value={newTagsetName}
          onChange={(e) => setNewTagsetName(e.currentTarget.value)}
          onKeyDown={(e) => isEnter(e) && handleAddTagset()}
        />
        <Button onClick={handleAddTagset} disabled={!newTagsetName.trim()}>
          <Plus className="h-4 w-4" /> {t('Add tagset')}
        </Button>
      </div>

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={t('Delete tagset “{name}”?', { name: pendingDelete ?? '' })}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          const name = pendingDelete;
          setPendingDelete(null);
          if (name) handleDeleteTagset(name);
        }}
      >
        <p>
          {(usage?.[pendingDelete] || []).length === 0
            ? t('No field uses it.')
            : `${t(
                '{fields} {n, plural, one {uses} other {use}} it and will accept any value again.',
                {
                  fields: usage[pendingDelete].map(fieldWithScope).join(', '),
                  n: usage[pendingDelete].length,
                },
              )} ${keptNote}`}
        </p>
      </ConfirmDeleteDialog>
    </div>
  );
};

// One value row. The description is edited inline because almost every tagset
// has one; anything else the project hangs off the tag lives behind the
// expander, preserved verbatim.
const ValueRow = ({
  rec,
  extras,
  reserved = false,
  reservedMessage,
  expanded,
  onToggle,
  onPatch,
  onReplace,
  onRemove,
}) => {
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
            title={
              extras.length ? t('{n} more field(s)', { n: extras.length }) : t('Add custom fields')
            }
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
            readOnly={reserved}
            title={reserved ? reservedMessage(rec.value) : undefined}
            aria-label={t('Value {value}', { value: rec.value })}
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
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={reserved}
            title={reserved ? reservedMessage(rec.value) : t('Remove value')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-muted/30">
          <td></td>
          <td colSpan={3} className="px-2 py-2">
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
                  title={t('Remove field')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <div className="mt-2 flex items-center gap-2">
              <Input
                className="h-7 w-32 font-mono"
                placeholder={t('key')}
                value={newKey}
                onChange={(e) => setNewKey(e.currentTarget.value)}
              />
              <Input
                className="h-7 max-w-md"
                placeholder={t('value')}
                value={newVal}
                onChange={(e) => setNewVal(e.currentTarget.value)}
                onKeyDown={(e) => isEnter(e) && addExtra()}
              />
              <Button size="sm" variant="outline" disabled={!newKey.trim()} onClick={addExtra}>
                <Plus className="h-3.5 w-3.5" /> {t('Add')}
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
};
