import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { ArrowUp, ArrowDown, X, FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { humanizeFieldName } from '@/domain/vocabFields';
import {
  descendantsOf,
  referencesTo,
  refIds,
  withRefIds,
  allExamples,
} from '@/domain/vocabDictionary';
import { loadConcordanceGroups, sentenceTo } from './vocabConcordance';
import { ItemPicker } from './ItemPicker';

// The dictionary panels of an entry: where it sits in its sense tree, what
// refers to it, and its examples. All of them only mount when the
// vocabulary's Dictionary switch is on.

const FormLabel = ({ form, index, className = '' }) => (
  <span className={className}>
    {form}
    {index != null && <sub className="ml-0.5 text-[0.7em] text-muted-foreground">{index}</sub>}
  </span>
);

/** An entry named inline as a link to it: form, subscript, gloss. */
const ItemLink = ({ item, homonyms, itemTo, className }) => (
  <Link to={itemTo(item.id)} className={cn('no-underline hover:underline', className)}>
    <FormLabel form={item.form} index={homonyms?.get(item.id)} className="font-medium" />
    {item.metadata?.gloss ? (
      <span className="ml-1 text-xs text-muted-foreground">{String(item.metadata.gloss)}</span>
    ) : null}
  </Link>
);

/**
 * A sense's number, editable: type the number it should be shown with and
 * press Enter (or leave the box), and it moves there among its siblings.
 * The box only ever edits the last segment ("3.1" -> the 1).
 */
const SenseNumber = ({ number, canManage, onSet, className, alone = false }) => {
  const parts = String(number ?? '').split('.');
  const last = parts.pop();
  const prefix = parts.length ? `${parts.join('.')}.` : '';
  const [draft, setDraft] = useState(last);
  useEffect(() => setDraft(last), [last]);
  // The box always snaps back to what the sense is numbered; when the
  // number changes, the effect above brings the new one in.
  const commit = () => {
    if (draft.trim() !== '' && draft.trim() !== last) onSet(draft.trim());
    setDraft(last);
  };
  // Nothing to move an only sense among, so its number is plain text.
  if (!canManage || alone) return <span className={cn('tabular-nums', className)}>{number}</span>;
  return (
    <span className={cn('inline-flex items-center tabular-nums', className)}>
      {prefix}
      <Input
        aria-label="Sense number"
        inputMode="numeric"
        className="h-6 w-10 px-1 text-center text-xs tabular-nums"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setDraft(last);
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
};

const Chip = ({ children, onRemove, disabled }) => (
  <span className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-sm">
    {children}
    {!disabled && onRemove && (
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
      >
        <X className="h-3 w-3" />
      </button>
    )}
  </span>
);

/**
 * The input for a reference field on the entry form: the entries it names as
 * chips (each a link), and a picker to add one. A single field's picker goes
 * away once it holds an entry.
 */
export const ItemRefField = ({
  id,
  field,
  values,
  onChange,
  items,
  homonyms,
  itemTo,
  selfId,
  disabled,
}) => {
  const ids = refIds({ metadata: values }, field);
  const byId = useMemo(() => new Map((items || []).map((it) => [it.id, it])), [items]);
  const exclude = useMemo(() => new Set([selfId, ...ids].filter(Boolean)), [selfId, ids]);
  const set = (next) => onChange(withRefIds(values, field, next));
  return (
    <div className="flex flex-col gap-1.5">
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {ids.map((x) => {
            const it = byId.get(x);
            return (
              <Chip key={x} disabled={disabled} onRemove={() => set(ids.filter((y) => y !== x))}>
                {it ? (
                  <ItemLink item={it} homonyms={homonyms} itemTo={itemTo} />
                ) : (
                  <span className="text-muted-foreground">(missing entry)</span>
                )}
              </Chip>
            );
          })}
        </div>
      )}
      {(field.many || ids.length === 0) && !disabled && (
        <ItemPicker
          id={id}
          items={items}
          homonyms={homonyms}
          exclude={exclude}
          onPick={(x) => set([...ids, x])}
          placeholder={`Find an entry for ${humanizeFieldName(field.name).toLowerCase()}…`}
        />
      )}
    </div>
  );
};

/**
 * Where the entry sits: "Entry" with a way to make it a sense of another, or
 * "Sense N of <parent>" with a way to make it an entry again.
 */
export const EntryPlace = ({
  item,
  tree,
  items,
  homonyms,
  itemTo,
  canManage,
  onSetParent,
  onSetNumber,
}) => {
  const [open, setOpen] = useState(false);
  const parentId = tree.parentOf.get(item.id);
  const parent = parentId ? tree.byId.get(parentId) : null;
  const number = tree.numberOf.get(item.id);
  const alone = parentId ? (tree.childrenOf.get(parentId) || []).length < 2 : true;
  const exclude = useMemo(
    () => new Set([item.id, ...descendantsOf(tree, item.id).map((d) => d.id)]),
    [tree, item.id],
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {parent ? (
        <span>
          Sense{' '}
          <SenseNumber
            number={number}
            canManage={canManage}
            alone={alone}
            onSet={(n) => onSetNumber(item.id, n)}
            className="mx-0.5"
          />{' '}
          of <ItemLink item={parent} homonyms={homonyms} itemTo={itemTo} />
        </span>
      ) : (
        <span>Entry</span>
      )}
      {canManage && parent && (
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => onSetParent(null)}
        >
          Make its own entry
        </button>
      )}
      {canManage && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="text-primary hover:underline">
              {parent ? 'Move under another entry…' : 'Make a sense of…'}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            <ItemPicker
              autoFocus
              items={items}
              homonyms={homonyms}
              exclude={exclude}
              onPick={(id) => {
                setOpen(false);
                onSetParent(id);
              }}
              placeholder="Find the entry…"
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
};

/** The senses under an entry, numbered, reorderable, with a way to add one. */
export const SensesPanel = ({
  item,
  tree,
  homonyms,
  itemTo,
  newSenseTo,
  canManage,
  onMove,
  onSetNumber,
}) => {
  const children = tree.childrenOf.get(item.id) || [];
  if (!children.length && !canManage) return null;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">Senses</span>
        {canManage && (
          <Button variant="ghost" size="sm" className="h-7" asChild>
            <Link to={newSenseTo(item.id)}>
              <Plus className="h-3.5 w-3.5" /> Add sense
            </Link>
          </Button>
        )}
      </div>
      {children.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No senses under this entry.</p>
      ) : (
        <ul className="divide-y">
          {children.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
              <SenseNumber
                number={tree.numberOf.get(c.id)}
                canManage={canManage}
                alone={children.length < 2}
                onSet={(n) => onSetNumber(c.id, n)}
                className="w-14 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">
                <ItemLink item={c} homonyms={homonyms} itemTo={itemTo} />
                {(tree.childrenOf.get(c.id) || []).length > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    +{descendantsOf(tree, c.id).length}
                  </span>
                )}
              </span>
              {canManage && (
                <span className="flex items-center gap-0.5 text-muted-foreground">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => onMove(c.id, -1)}
                    className="rounded p-1 hover:text-foreground disabled:opacity-25"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === children.length - 1}
                    onClick={() => onMove(c.id, 1)}
                    className="rounded p-1 hover:text-foreground disabled:opacity-25"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Everything that points at this entry, computed, read-only. */
export const ReferencedByPanel = ({ item, items, fields, homonyms, itemTo }) => {
  const refs = useMemo(
    () => referencesTo(items, fields, item.id).filter((r) => r.field),
    [items, fields, item.id],
  );
  if (!refs.length) return null;
  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-2">
        <span className="text-sm font-medium">Referenced by</span>
      </div>
      <ul className="divide-y">
        {refs.map((r, i) => (
          <li key={i} className="flex items-center gap-2 px-4 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <ItemLink item={r.item} homonyms={homonyms} itemTo={itemTo} />
            </span>
            <span className="text-xs text-muted-foreground">{humanizeFieldName(r.field.name)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// Render sentence text with <mark>s over hit ranges (sentence-relative, sorted).
export const MarkedText = ({ text, marks }) => {
  if (!marks?.length) return <>{text}</>;
  const chars = [...text];
  const out = [];
  let pos = 0;
  marks.forEach((m, i) => {
    const b = Math.max(pos, Math.min(m.begin, chars.length));
    const e = Math.max(b, Math.min(m.end, chars.length));
    if (b > pos) out.push(chars.slice(pos, b).join(''));
    out.push(
      <mark key={i} className="rounded bg-yellow-200 px-0.5">
        {chars.slice(b, e).join('')}
      </mark>,
    );
    pos = e;
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <>{out}</>;
};

/** One sentence of context, as the concordance and the examples draw it. */
export const ContextRow = ({ row, to }) => {
  const body = (
    <>
      <p className="text-sm text-foreground">
        <span className="mr-2 text-xs text-muted-foreground">#{row.sentenceIndex + 1}</span>
        <MarkedText text={row.text} marks={row.marks} />
      </p>
      {row.notes?.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {[...new Set(row.notes)].join(' · ')}
        </p>
      )}
      {row.translation && (
        <p className="mt-0.5 text-xs italic text-muted-foreground">‘{row.translation}’</p>
      )}
    </>
  );
  // Without a project (an unreadable one) there is nowhere to go, so the row
  // is just text.
  return to ? (
    <Link
      to={to}
      className="block min-w-0 flex-1 px-3 py-1.5 text-left no-underline hover:bg-muted/50"
      title="Open in Analyze (middle-click for a new tab)"
    >
      {body}
    </Link>
  ) : (
    <div className="block min-w-0 flex-1 px-3 py-1.5 text-left">{body}</div>
  );
};

/**
 * The entry's examples, resolved live: a reference is looked up in its
 * document and shown in context, or marked as gone when the token no longer
 * exists or no longer links here. Imported text examples show as text.
 *
 * `linkedTokenIds` is the concordance plan's set of tokens linked to this
 * entry (null while loading, or when the plan was capped and cannot say).
 */
export const ExamplesPanel = ({ item, client, linkedTokenIds, canManage, onRemove }) => {
  const examples = useMemo(() => allExamples(item), [item]);
  const refKey = examples
    .filter((e) => e.document)
    .map((e) => `${e.document}/${e.token}`)
    .join(',');
  const [resolved, setResolved] = useState(null); // Map "doc/token" -> {row, projectId, docName} | null
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!refKey) {
      setResolved(new Map());
      return undefined;
    }
    let alive = true;
    setLoading(true);
    const refs = examples.filter((e) => e.document);
    const byDoc = new Map();
    for (const r of refs) byDoc.set(r.document, (byDoc.get(r.document) || 0) + 1);
    const tokenIds = new Set(refs.map((r) => r.token));
    (async () => {
      const out = new Map();
      await Promise.all(
        [...byDoc.entries()].map(async ([docId, n]) => {
          try {
            const [g] = await loadConcordanceGroups(client, tokenIds, [[docId, n]]);
            for (const row of g.rows) {
              for (const t of row.tokenIds || []) {
                if (tokenIds.has(t))
                  out.set(`${docId}/${t}`, { row, projectId: g.projectId, docName: g.docName });
              }
            }
          } catch {
            // an unreadable or deleted document: its references show as gone
          }
        }),
      );
      if (!alive) return;
      setResolved(out);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, refKey]);

  if (!examples.length) return null;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">Examples</span>
        <span className="text-xs text-muted-foreground">{examples.length}</span>
      </div>
      <ol className="divide-y">
        {examples.map((ex, i) => {
          if (!ex.document) {
            return (
              <li key={i} className="flex items-start gap-2 px-1 py-1">
                <span className="w-6 shrink-0 pt-1.5 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 px-3 py-1.5 text-sm">
                  <span>{ex.text}</span>
                  {ex.translation && (
                    <span className="block text-xs italic text-muted-foreground">
                      ‘{ex.translation}’
                    </span>
                  )}
                </div>
                {canManage && (
                  <button
                    type="button"
                    aria-label="Remove example"
                    onClick={() => onRemove(i)}
                    className="mt-1.5 rounded p-1 text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          }
          const hit = resolved?.get(`${ex.document}/${ex.token}`) || null;
          const unlinked = linkedTokenIds && !linkedTokenIds.has(ex.token);
          const gone = !loading && resolved && (!hit || unlinked);
          return (
            <li key={i} className="flex items-start gap-2 px-1 py-1">
              <span className="w-6 shrink-0 pt-1.5 text-right text-xs tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              {loading && !hit ? (
                <div className="min-w-0 flex-1 px-3 py-1.5 text-sm text-muted-foreground">…</div>
              ) : gone ? (
                <div className="min-w-0 flex-1 px-3 py-1.5 text-sm text-muted-foreground">
                  This example no longer exists, or its word is no longer linked to this entry.
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <ContextRow
                    row={hit.row}
                    to={sentenceTo(hit.projectId, ex.document, hit.row.sentenceId)}
                  />
                  <p className="flex items-center gap-1 px-3 pb-1 text-xs text-muted-foreground">
                    <FileText className="h-3 w-3" /> {hit.docName}
                  </p>
                </div>
              )}
              {canManage && (
                <button
                  type="button"
                  aria-label="Remove example"
                  onClick={() => onRemove(i)}
                  className="mt-1.5 rounded p-1 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
