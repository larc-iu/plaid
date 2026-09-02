import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { notifySuccess, notifyError, notifyInfo } from '@/utils/feedback';
import { ConfirmDeleteDialog } from '@/components/shared/ConfirmDeleteDialog';
import { RESERVED_VALUE_KEYS, scanValue, seedValueRecords } from '@/domain/tagsets';

// The editor for a project's tagsets. Owns a draft of the whole map and hands
// the whole map back on every discrete change (add/delete/toggle) or on blur
// for the text inputs, so a rename does not write once per keystroke.
//
// `usage` maps a tagset name to the fields referencing it ([{scope, name}]),
// which is what makes a delete safe to reason about. `onLoadAttested(name)`
// returns the [value, count] rows actually present in those fields, for the
// "add attested values" seed.

const SAMPLE = '1SG.NOM';

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
  const [pendingDelete, setPendingDelete] = useState(null);

  const save = async (next) => {
    setDraft(next);
    try {
      await onSaveChanges(next);
    } catch {
      // The settings wrapper reports it; roll the draft back so what's on
      // screen is what the server has.
      setDraft(tagsets);
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
    await save({ ...draft, [name]: { delimiters: '', closed: false, values: [] } });
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
    await save(next);
    setOpenName(name);
    // Fields point at a tagset BY NAME, so a rename orphans them until they are
    // repointed. Say so rather than silently breaking the reference.
    const fields = usage?.[from] || [];
    if (fields.length) {
      notifyInfo(
        `${fields.length} field${fields.length === 1 ? '' : 's'} still points at "${from}". Repoint ${fields.length === 1 ? 'it' : 'them'} in Annotation Fields.`,
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

  // The attested rows are per-tagset (they come from the fields referencing it),
  // so this is never cached across tagsets.
  const handleSeedAttested = async (name) => {
    try {
      const rows = await onLoadAttested(name);
      const n = await handleAddValues(name, seedValueRecords(rows, draft[name]));
      if (n) notifySuccess(`Added ${n} value${n === 1 ? '' : 's'} found in this project`, 'Seeded');
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

  const patchValue = (name, index, changes) => {
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
          No tagsets yet. Create one here, then point an annotation field at it in Annotation
          Fields.
        </p>
      )}

      {names.map((name) => {
        const t = draft[name];
        const isOpen = openName === name;
        const fields = usage?.[name] || [];
        const preview = scanValue(SAMPLE, t.delimiters);
        return (
          <div key={name} className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-2 px-3 py-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => setOpenName(isOpen ? null : name)}
                title={isOpen ? 'Collapse' : 'Expand'}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
              <span className="font-medium">{name}</span>
              <Badge
                variant="secondary"
                className={
                  t.closed
                    ? 'border-transparent bg-amber-100 text-amber-800'
                    : 'border-transparent bg-slate-100 text-slate-700'
                }
              >
                {t.closed ? 'Closed' : 'Open'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t.values.length} value{t.values.length === 1 ? '' : 's'}
                {t.delimiters && ` · split on ${[...t.delimiters].join(' ')}`}
                {fields.length > 0 &&
                  ` · used by ${fields.map((f) => `${f.name} (${f.scope})`).join(', ')}`}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto h-7 w-7 text-destructive hover:text-destructive"
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

                {/* Closed */}
                <label className="flex max-w-2xl items-start gap-3">
                  <Switch
                    checked={t.closed}
                    onCheckedChange={(closed) => patch(name, { closed })}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-sm font-medium">Closed</span>
                    <span className="block text-xs text-muted-foreground">
                      Values outside the list are rejected when typed into a cell. Open tagsets
                      offer the list but accept anything. Either way this is a Plaid IGT rule, not a
                      database constraint: imports, services and the assistant can still write other
                      values, and the Validation tab is where you find them.
                    </span>
                  </span>
                </label>

                {/* Delimiters */}
                <div className="flex max-w-2xl flex-col gap-1">
                  <p className="text-sm font-medium">Delimiters</p>
                  <p className="text-xs text-muted-foreground">
                    Characters that separate the parts of a composite value, so each part is checked
                    on its own. Leave empty to treat the whole cell as one value (right for a part
                    of speech; wrong for a gloss like <code>1SG.NOM</code>).
                  </p>
                  <Input
                    className="max-w-[12rem] font-mono"
                    placeholder="e.g. .:>"
                    defaultValue={t.delimiters}
                    onBlur={(e) => patch(name, { delimiters: e.currentTarget.value })}
                  />
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
                  {t.values.length > 0 && (
                    <div className="overflow-hidden rounded-md border bg-background">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-muted-foreground">
                            <th className="w-8 px-2 py-1.5"></th>
                            <th className="w-[22%] px-2 py-1.5 text-left font-medium">Value</th>
                            <th className="px-2 py-1.5 text-left font-medium">Description</th>
                            <th className="w-24 px-2 py-1.5 text-left font-medium">Color</th>
                            <th className="w-8 px-2 py-1.5"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.values.map((rec, i) => {
                            const key = `${name}:${i}`;
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
                    </div>
                  )}

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
                          ? 'No annotation field uses this tagset yet, so there are no values to read. Point a field at it in Annotation Fields below.'
                          : `Read every value already used in ${fields.map((f) => f.name).join(', ')}`
                      }
                    >
                      <Sparkles className="h-4 w-4" /> Add values used in this project
                    </Button>
                  </div>

                  {pasteOpen && (
                    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <p className="text-xs text-muted-foreground">
                        One value per line, or comma separated. Values already in the tagset are
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
            ? 'No annotation field uses it. No annotations are affected.'
            : `${usage[pendingDelete].map((f) => `${f.name} (${f.scope})`).join(', ')} still points at it, and will fall back to accepting any value. No annotations are deleted or changed.`}
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
              if (v && v !== rec.value) onPatch({ value: v });
              else e.currentTarget.value = rec.value;
            }}
          />
        </td>
        <td className="px-2 py-1">
          <Input
            className="h-7"
            defaultValue={rec.description ?? ''}
            onBlur={(e) => onPatch({ description: e.currentTarget.value })}
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
            className="h-6 w-6 text-destructive hover:text-destructive"
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
                  onBlur={(e) => onPatch({ [k]: e.currentTarget.value })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive hover:text-destructive"
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
