import { useMemo, useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { pageSlice } from '@ui/hooks/usePagedList';
import { ListPager } from '@ui/components/ui/list-search';
import { Button } from '@ui/components/ui/button';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A native checkbox rather than a Radix one: the document header needs the
// indeterminate state, which lives only on the DOM node and cannot be set from
// markup, and every one of these sits inside a plain row that wants nothing
// else from a primitive.
const Check = ({ indeterminate = false, className = '', ...props }) => {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={`h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
};

// The rewrite preview: every sentence a rule changed, grouped by document,
// each with its change lines and a checkbox. `rows` come from planRewrite;
// `selected` is the set of row keys to apply. Sentences are links into the
// annotation editor (deep-linked via ?sent=), built by `hrefFor`.
export const RewritePreview = ({ rows, selected, onSelect, hrefFor, canApply, busy, onApply }) => {
  const [page, setPage] = useState(0);
  const confirm = useConfirm();
  useEffect(() => {
    setPage(0);
  }, [rows]);

  const paged = useMemo(() => pageSlice(rows, page), [rows, page]);
  const { pageItems } = paged;
  const byDoc = useMemo(() => {
    const m = new Map();
    for (const r of pageItems) {
      if (!m.has(r.docId)) m.set(r.docId, []);
      m.get(r.docId).push(r);
    }
    return [...m.entries()];
  }, [pageItems]);

  const applicable = rows.filter((r) => !r.error);
  const chosen = applicable.filter((r) => selected.has(r.key));
  const chosenDocs = new Set(chosen.map((r) => r.docId));
  const errors = rows.length - applicable.length;
  const warned = rows.filter((r) => r.warnings.length).length;

  const setMany = (keys, on) => {
    const next = new Set(selected);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    onSelect(next);
  };

  const confirmApply = async () => {
    const ok = await confirm({
      title: 'Apply changes',
      description: `${plural(chosen.length, 'sentence')} in ${plural(chosenDocs.size, 'document')}.`,
      confirmLabel: 'Apply',
    });
    if (ok) onApply();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length === 0
            ? 'No sentences to change.'
            : `${plural(rows.length, 'sentence')} in ${plural(new Set(rows.map((r) => r.docId)).size, 'document')}, ${chosen.length} selected` +
              (errors ? `, ${plural(errors, 'error')}` : '') +
              (warned ? `, ${plural(warned, 'warning')}` : '')}
        </p>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setMany(
                  applicable.map((r) => r.key),
                  chosen.length !== applicable.length,
                )
              }
            >
              {chosen.length !== applicable.length ? 'Select all' : 'Select none'}
            </Button>
            {canApply ? (
              <Button onClick={confirmApply} disabled={!chosen.length || busy}>
                {busy ? 'Applying…' : `Apply ${plural(chosen.length, 'change')}`}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Maintainers only.</p>
            )}
          </div>
        )}
      </div>

      <ListPager {...paged} onPage={setPage} position="top" className="rounded-md border" />

      {byDoc.map(([docId, sentences]) => {
        const keys = sentences.filter((r) => !r.error).map((r) => r.key);
        const on = keys.filter((k) => selected.has(k)).length;
        return (
          <div key={docId} className="overflow-hidden rounded-md border">
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <Check
                checked={keys.length > 0 && on === keys.length}
                indeterminate={on > 0 && on < keys.length}
                disabled={!keys.length}
                onChange={(e) => setMany(keys, e.currentTarget.checked)}
                aria-label="Select document"
              />
              <span className="truncate text-sm font-semibold">{sentences[0].docName}</span>
            </div>
            <div className="flex flex-col">
              {sentences.map((r, idx) => (
                <div key={r.key} className={`flex gap-3 p-4 ${idx ? 'border-t' : ''}`}>
                  <Check
                    className="mt-1"
                    checked={selected.has(r.key)}
                    disabled={!!r.error}
                    onChange={(e) => setMany([r.key], e.currentTarget.checked)}
                    aria-label="Select sentence"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <Link
                        to={hrefFor(r.docId, r.id)}
                        className="text-sm leading-relaxed text-primary underline-offset-4 hover:underline"
                      >
                        {r.text}
                      </Link>
                      {r.applications > 1 && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {r.applications}×
                        </span>
                      )}
                    </div>
                    {r.changes.map((c, i) => (
                      <p key={i} className="font-mono text-xs">
                        {c.text}
                      </p>
                    ))}
                    {r.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-700">
                        {w}
                      </p>
                    ))}
                    {r.error && <p className="text-xs text-destructive">{r.error}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <ListPager {...paged} onPage={setPage} className="rounded-md border" />
    </div>
  );
};
