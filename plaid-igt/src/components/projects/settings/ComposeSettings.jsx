import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notifyError } from '@/utils/feedback';
import { IGT_NAMESPACE, readCompose } from '@/domain/igtConfig';
import {
  BUILT_IN_TABLE,
  CODE_LENGTH,
  readProjectCodes,
  shadowsBuiltIn,
  validateCode,
} from '@/domain/composeConfig';

const BUILT_IN_ROWS = Object.entries(BUILT_IN_TABLE).sort(([a], [b]) =>
  a.toLowerCase().localeCompare(b.toLowerCase()),
);

const blankRow = () => ({ code: '', char: '', description: '' });

/** The searchable list of codes that work without any setup. */
const BuiltInReference = () => {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return BUILT_IN_ROWS.filter(
      ([code, char]) => code.toLowerCase().includes(needle) || char === needle,
    ).slice(0, 60);
  }, [q]);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="compose-search" className="text-xs font-normal text-muted-foreground">
        Look up a built-in code
      </Label>
      <div className="relative max-w-sm">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          id="compose-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Paste a character, or type part of a code"
          className="h-9 pl-8"
          spellCheck={false}
        />
      </div>
      {q.trim() !== '' && (
        <div className="max-h-48 overflow-y-auto rounded-md border">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            <ul className="divide-y">
              {matches.map(([code, char]) => (
                <li key={code} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <code className="w-20 shrink-0 text-muted-foreground">{`\\${code}`}</code>
                  <span className="text-base">{char}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Settings → Text and Vocab → Special characters. A project's own backslash
 * codes, on top of the built-in ones.
 */
export const ComposeSettings = ({ project, projectId, client, onProjectUpdate }) => {
  const saved = useMemo(() => readProjectCodes(project?.config), [project?.config]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const problems = draft.map((row) => validateCode(row, draft));
  const canSave = dirty && !saving && problems.every((p) => p.length === 0);

  const setRow = (i, patch) =>
    setDraft((rows) => rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  const removeRow = (i) => setDraft((rows) => rows.filter((_, j) => j !== i));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (!client) throw new Error('Not authenticated');
      const codes = draft.map(({ code, char, description }) =>
        description ? { code, char, description } : { code, char },
      );
      // Keep any other keys under `compose` that a later version may add.
      const existing = readCompose(project?.config) || {};
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'compose', { ...existing, codes });
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
        not have: <code>\sw</code> gives ə, <code>\0/</code> gives ∅. Hundreds of codes work
        already, and you can add codes of your own for this project below.
      </p>

      <div className="flex max-w-3xl flex-col gap-6">
        <BuiltInReference />

        <div className="flex flex-col gap-2">
          <Label className="text-xs font-normal text-muted-foreground">This project's codes</Label>
          {draft.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              No codes of your own yet. Add one if this language is written with a character the
              built-in codes do not cover.
            </p>
          )}

          {draft.map((row, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-md border p-3">
              <div className="flex items-end gap-2">
                <div className="flex w-28 flex-col gap-1">
                  <Label htmlFor={`code-${i}`} className="text-xs font-normal">
                    Code
                  </Label>
                  <Input
                    id={`code-${i}`}
                    value={row.code}
                    onChange={(e) => setRow(i, { code: e.target.value })}
                    placeholder="b'"
                    className="h-8 font-mono"
                    spellCheck={false}
                    aria-invalid={problems[i].length > 0 || undefined}
                  />
                </div>
                <div className="flex w-24 flex-col gap-1">
                  <Label htmlFor={`char-${i}`} className="text-xs font-normal">
                    Types
                  </Label>
                  <Input
                    id={`char-${i}`}
                    compose
                    value={row.char}
                    onChange={(e) => setRow(i, { char: e.target.value })}
                    placeholder="ɓ"
                    className="h-8 text-base"
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor={`desc-${i}`} className="text-xs font-normal">
                    Note (optional)
                  </Label>
                  <Input
                    id={`desc-${i}`}
                    value={row.description || ''}
                    onChange={(e) => setRow(i, { description: e.target.value })}
                    placeholder="implosive b"
                    className="h-8"
                  />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={() => removeRow(i)}
                  title="Remove this code"
                  aria-label={`Remove code ${row.code || i + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {problems[i].map((p) => (
                <p key={p} className="text-xs text-destructive">
                  {p}
                </p>
              ))}
              {problems[i].length === 0 && shadowsBuiltIn(row.code) && (
                <p className="text-xs text-muted-foreground">
                  Replaces the built-in <code>{`\\${row.code}`}</code>, which types{' '}
                  {BUILT_IN_TABLE[row.code]}.
                </p>
              )}
            </div>
          ))}

          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft((rows) => [...rows, blankRow()])}
            >
              <Plus className="h-4 w-4" /> Add a code
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A code is exactly {CODE_LENGTH} characters, and never a space or a backslash.
          </p>
        </div>

        <div>
          <Button onClick={save} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save codes'}
          </Button>
        </div>
      </div>
    </div>
  );
};
