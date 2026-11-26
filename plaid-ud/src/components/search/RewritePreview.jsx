import { useMemo, useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { pageSlice, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { ListPager } from '@ui/components/shared/list-search';
import { Button } from '@ui/components/ui/button';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { detectDirection } from '@ui/domain/textDirection.js';
import { lossPhrase } from '@ui/domain/annotationLoss.js';
import { t } from '@ui/lib/i18n.js';

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
// each with its change lines and a checkbox. The tallest rows in the app, and
// each one is a decision rather than something to scan past, so it pages at
// the tall-row size. `rows` come from planRewrite;
// `selected` is the set of row keys to apply. Sentences are links into the
// annotation editor (deep-linked via ?sent=), built by `hrefFor`.
export const RewritePreview = ({ rows, selected, onSelect, hrefFor, canApply, busy, onApply }) => {
  const [page, setPage] = useState(0);
  const confirm = useConfirm();
  useEffect(() => {
    setPage(0);
  }, [rows]);

  const paged = useMemo(() => pageSlice(rows, page, TALL_LIST_PAGE_SIZE), [rows, page]);
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
  const counted = { n: rows.length, docs: new Set(rows.map((r) => r.docId)).size };

  const setMany = (keys, on) => {
    const next = new Set(selected);
    keys.forEach((k) => (on ? next.add(k) : next.delete(k)));
    onSelect(next);
  };

  // What the chosen rows' deleted words take on the text's other layers, and
  // what they only cut down. Each row counts its own once.
  const sum = (pick) =>
    chosen.reduce(
      (acc, r) => ({
        annotations: acc.annotations + (pick(r)?.annotations || 0),
        links: acc.links + (pick(r)?.links || 0),
      }),
      { annotations: 0, links: 0 },
    );
  const lost = lossPhrase(sum((r) => r.loss));
  const cut = lossPhrase(sum((r) => r.loss?.shortened));

  const confirmApply = async () => {
    // The description's parts are each a sentence of their own.
    const ok = await confirm({
      title: t('Apply changes?'),
      description: [
        t(
          '{n, plural, one {# sentence} other {# sentences}} in {docs, plural, one {# document} other {# documents}}.',
          { n: chosen.length, docs: chosenDocs.size },
        ),
        lost && t('Deletes {loss} with the deleted words.', { loss: lost }),
        cut && t('Shortens {cut}.', { cut }),
      ]
        .filter(Boolean)
        .join(' '),
      confirmLabel: t('Apply'),
      destructive: Boolean(lost || cut),
    });
    if (ok) onApply();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {rows.length === 0
            ? t('No sentences to change.')
            : errors
              ? t(
                  '{n, plural, one {# sentence} other {# sentences}} in {docs, plural, one {# document} other {# documents}}, {chosen} selected, {errors, plural, one {# error} other {# errors}}',
                  { ...counted, chosen: chosen.length, errors },
                )
              : t(
                  '{n, plural, one {# sentence} other {# sentences}} in {docs, plural, one {# document} other {# documents}}, {chosen} selected',
                  { ...counted, chosen: chosen.length },
                )}
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
              {chosen.length !== applicable.length ? t('Select all') : t('Select none')}
            </Button>
            {canApply ? (
              <Button onClick={confirmApply} disabled={!chosen.length || busy}>
                {busy
                  ? t('Applying…')
                  : t('Apply to {n, plural, one {# sentence} other {# sentences}}', {
                      n: chosen.length,
                    })}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">{t('Maintainers only.')}</p>
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
                aria-label={t('Select document')}
              />
              <span dir="auto" className="truncate text-sm font-semibold">
                {sentences[0].docName}
              </span>
            </div>
            <div className="flex flex-col">
              {sentences.map((r, idx) => (
                <div key={r.key} className={`flex gap-3 p-4 ${idx ? 'border-t' : ''}`}>
                  <Check
                    className="mt-1"
                    checked={selected.has(r.key)}
                    disabled={!!r.error}
                    onChange={(e) => setMany([r.key], e.currentTarget.checked)}
                    aria-label={t('Select sentence')}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <Link
                        to={hrefFor(r.docId, r.id)}
                        dir={detectDirection(r.text)}
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
                      <p key={i} className={`text-xs ${c.loss ? 'text-destructive' : ''}`}>
                        {c.parts.map((part, j) => (j % 2 ? <bdi key={j}>{part}</bdi> : part))}
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
