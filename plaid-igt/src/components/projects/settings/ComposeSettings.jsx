import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SearchInput, ListCount, ListPager } from '@/components/ui/list-search';
import { usePagedList } from '@/hooks/usePagedList';
import { notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE, readCompose } from '@/domain/igtConfig';
import {
  BUILT_IN_TABLE,
  CODE_LENGTH,
  builtInRow,
  composeRows,
  isBuiltInCode,
  rowsToConfig,
  validateCode,
} from '@/domain/composeConfig';

const ORIGIN_LABEL = {
  changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
};

const byCode = (a, b) => a.code.toLowerCase().localeCompare(b.code.toLowerCase());

// A row's identity for React, fixed when the row appears and never derived from
// what is being typed into it. Deriving the key from the code (or from whether
// the row counts as changed) remounts the row on the FIRST keystroke, which
// takes focus out of the field the person is typing in.
let nextUid = 0;
const withUid = (row) => ({ ...row, uid: `row-${nextUid++}` });

/**
 * Settings → Text and Vocab → Special characters. Every code is an entry here:
 * the built-in ones can be pointed somewhere else or taken out, and a project
 * can add its own. Only what a project actually changed is stored, so a code
 * nobody touched still picks up a correction later.
 */
export const ComposeSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const saved = useMemo(
    () => composeRows(project?.config).sort(byCode).map(withUid),
    [project?.config],
  );
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const problemsByCode = useMemo(() => {
    const m = new Map();
    for (const row of draft) m.set(row, validateCode(row, draft));
    return m;
  }, [draft]);
  const canSave = dirty && !saving && [...problemsByCode.values()].every((p) => p.length === 0);

  const changedCount = draft.filter((r) => r.origin !== 'built-in').length;

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return draft;
    return draft.filter(
      (r) =>
        r.code.toLowerCase().includes(needle) ||
        r.char === q.trim() ||
        (r.description || '').toLowerCase().includes(needle),
    );
  }, [draft, q]);

  const paged = usePagedList(matches, { pageSize: 25, resetKey: q });

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

  const removeRow = (row) => {
    if (isBuiltInCode(row.code)) patch(row, { origin: 'removed' });
    else setDraft((rows) => rows.filter((r) => r !== row));
  };

  const resetRow = (row) => {
    const base = builtInRow(row.code);
    if (base) patch(row, { ...base, origin: 'built-in' });
  };

  const addRow = () => {
    setQ('');
    setDraft((rows) => [
      withUid({ code: '', char: '', description: '', origin: 'added' }),
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
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'compose', {
        ...existing,
        ...rowsToConfig(draft),
      });
      onProjectUpdate?.();
    } catch (err) {
      console.error('Failed to save the project codes:', err);
      notifyError('Saving the codes failed. Please try again.', 'Error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tw">
      <h2 className="text-lg font-semibold">Special characters</h2>
      <p className="mb-4 mt-1 max-w-3xl text-sm text-muted-foreground">
        Type a backslash and a two-letter code in any field to enter a character your keyboard does
        not have: <code>\sw</code> gives ə, <code>\00</code> gives ∅. Every code is listed here.
        Change what one types, take one out, or add your own for this project.
      </p>

      <div className="flex max-w-4xl flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            className="w-full max-w-[20rem]"
            inputClassName="h-8"
            placeholder="Search codes…"
            value={q}
            onChange={setQ}
          />
          <ListCount shown={matches.length} total={draft.length} noun="code" />
          {changedCount > 0 && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              · {changedCount} changed by this project
            </span>
          )}
          <Button variant="outline" size="sm" className="ml-auto" onClick={addRow}>
            <Plus className="h-4 w-4" /> Add a code
          </Button>
        </div>

        <div className="overflow-hidden rounded-md border">
          <div className="grid grid-cols-[7rem_6rem_1fr_5.5rem] items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Code</span>
            <span>Types</span>
            <span>Note</span>
            <span />
          </div>
          <ListPager {...paged} onPage={paged.setPage} position="top" />
          {paged.pageItems.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">No codes match “{q}”.</p>
          )}
          {paged.pageItems.map((row) => {
            const problems = problemsByCode.get(row) || [];
            const gone = row.origin === 'removed';
            return (
              <div key={row.uid} className="border-b last:border-b-0" data-code-row={row.code}>
                <div className="grid grid-cols-[7rem_6rem_1fr_5.5rem] items-center gap-2 px-3 py-1.5">
                  {isBuiltInCode(row.code) ? (
                    <code
                      className={`text-sm ${gone ? 'text-muted-foreground line-through' : ''}`}
                      title="A built-in code. Change what it types, or take it out."
                    >{`\\${row.code}`}</code>
                  ) : (
                    <Input
                      value={row.code}
                      onChange={(e) => editRow(row, { code: e.target.value })}
                      placeholder="b'"
                      aria-label="Code"
                      className="h-8 font-mono"
                      spellCheck={false}
                      aria-invalid={problems.length > 0 || undefined}
                    />
                  )}
                  {gone ? (
                    <span className="text-sm text-muted-foreground line-through">{row.char}</span>
                  ) : (
                    <Input
                      compose
                      value={row.char}
                      onChange={(e) => editRow(row, { char: e.target.value })}
                      aria-label={`What \\${row.code || 'this code'} types`}
                      className="h-8 text-base"
                      spellCheck={false}
                    />
                  )}
                  {gone ? (
                    <span className="text-sm text-muted-foreground">Taken out of this project</span>
                  ) : (
                    <Input
                      value={row.description || ''}
                      onChange={(e) => editRow(row, { description: e.target.value })}
                      placeholder={isBuiltInCode(row.code) ? '' : 'implosive b'}
                      aria-label="Note"
                      className="h-8"
                    />
                  )}
                  <div className="flex items-center justify-end gap-1">
                    {ORIGIN_LABEL[row.origin] && (
                      <Badge variant="secondary" className="hidden font-normal sm:inline-flex">
                        {ORIGIN_LABEL[row.origin]}
                      </Badge>
                    )}
                    {row.origin !== 'built-in' && isBuiltInCode(row.code) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => resetRow(row)}
                        title="Put this code back the way it ships"
                        aria-label={`Reset code ${row.code}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {!gone && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => removeRow(row)}
                        title="Take this code out of the project"
                        aria-label={`Remove code ${row.code || 'new'}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                {problems.map((p) => (
                  <p key={p} className="px-3 pb-1.5 text-xs text-destructive">
                    {p}
                  </p>
                ))}
              </div>
            );
          })}
          <ListPager {...paged} onPage={paged.setPage} />
        </div>

        <p className="text-xs text-muted-foreground">
          A code is exactly {CODE_LENGTH} characters, and never a space or a backslash. There are{' '}
          {Object.keys(BUILT_IN_TABLE).length} built-in codes, taken from Praat, so a code you
          already know from there works here.
        </p>

        <div>
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save codes'}
          </Button>
        </div>
      </div>
    </div>
  );
};
