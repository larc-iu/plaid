import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, X, FileText, Plus } from 'lucide-react';
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
 * Where the entry sits: "Entry", or "Sense N of <parent>", with the number
 * editable, then the entry's whole sense tree, unfolded on demand. Moving is
 * done by dragging in the tree: above or below a sense to reorder, onto one
 * to nest under it, onto Own entry to free it, onto Another entry to pick
 * where it goes. A lone entry has nothing to drag, so it keeps a picker.
 */
export const EntryPlace = ({
  item,
  tree,
  items,
  homonyms,
  itemTo,
  canManage,
  onMoveUnder,
  onDrop,
  onSetNumber,
  newSenseTo,
}) => {
  // Which item the picker is choosing a parent for: this one (the lone
  // entry's link) or one dropped on Another entry.
  const [pickFor, setPickFor] = useState(null);
  const parentId = tree.parentOf.get(item.id);
  const parent = parentId ? tree.byId.get(parentId) : null;
  const number = tree.numberOf.get(item.id);
  const alone = parentId ? (tree.childrenOf.get(parentId) || []).length < 2 : true;
  const exclude = useMemo(
    () =>
      pickFor ? new Set([pickFor, ...descendantsOf(tree, pickFor).map((d) => d.id)]) : new Set(),
    [tree, pickFor],
  );
  const root = tree.byId.get(tree.rootOf.get(item.id));
  const senseCount = root ? descendantsOf(tree, root.id).length : 0;
  const [treeOpen, setTreeOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
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
        {senseCount > 0 && (
          <button
            type="button"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 text-primary hover:underline"
          >
            {treeOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {senseCount} sense{senseCount === 1 ? '' : 's'}
          </button>
        )}
        <Popover open={!!pickFor} onOpenChange={(o) => !o && setPickFor(null)}>
          {canManage && senseCount === 0 && !parent && (
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setPickFor(item.id)}
              >
                Make a sense of…
              </button>
            </PopoverTrigger>
          )}
          <PopoverContent align="start" className="w-80 p-2">
            <ItemPicker
              autoFocus
              items={items}
              homonyms={homonyms}
              exclude={exclude}
              onPick={(id) => {
                const moving = pickFor;
                setPickFor(null);
                onMoveUnder(moving, id);
              }}
              placeholder="Find the entry…"
            />
          </PopoverContent>
        </Popover>
        {canManage && (
          <Link to={newSenseTo(item.id)} className="text-primary no-underline hover:underline">
            <Plus className="inline h-3 w-3" /> Add sense
          </Link>
        )}
      </div>
      {treeOpen && senseCount > 0 && root && (
        <SenseTree
          root={root}
          current={item.id}
          tree={tree}
          homonyms={homonyms}
          itemTo={itemTo}
          canManage={canManage}
          onDrop={onDrop}
          onPickEntry={(id) => setPickFor(id)}
        />
      )}
    </div>
  );
};

// Which part of a row the pointer is over: the top and bottom quarters mean
// before and after it, the middle means into it.
const zoneAt = (event) => {
  const r = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - r.top) / Math.max(1, r.height);
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
};

/**
 * The whole entry as a tree, for getting around it and rearranging it: the
 * headword and every sense under it, depth-first and numbered, each a link,
 * the open one marked. Rows drag; while one is in the air two extra rows
 * appear at the top to drop it on: Own entry, and Another entry.
 */
const SenseTree = ({ root, current, tree, homonyms, itemTo, canManage, onDrop, onPickEntry }) => {
  const rows = [{ item: root, depth: 0 }];
  const walk = (id, depth) => {
    for (const c of tree.childrenOf.get(id) || []) {
      rows.push({ item: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(root.id, 1);
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null); // {id, zone} | 'root' | 'pick' | null
  const banned = useMemo(
    () => (dragId ? new Set([dragId, ...descendantsOf(tree, dragId).map((d) => d.id)]) : new Set()),
    [tree, dragId],
  );
  const end = () => {
    setDragId(null);
    setOver(null);
  };
  // The two places outside the tree a row can be dropped. Always there
  // when the tree can be edited, so the ways out are visible before a drag
  // starts; they light up while one is in the air.
  const dropZone = (key, label, onDropHere) => (
    <li
      key={key}
      data-drop={key}
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        setOver(key);
      }}
      onDragLeave={() => setOver((o) => (o === key ? null : o))}
      onDrop={(e) => {
        if (!dragId) return;
        e.preventDefault();
        onDropHere();
        end();
      }}
      className={cn(
        'mx-2 my-0.5 rounded border border-dashed px-2 py-0.5 text-xs text-muted-foreground/70',
        dragId && 'text-muted-foreground',
        over === key && 'border-primary bg-accent text-foreground',
      )}
    >
      {label}
    </li>
  );
  return (
    <ul className="max-h-72 overflow-y-auto rounded-md border bg-muted/20 py-1 text-sm">
      {canManage && (
        <li className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Drag a sense to
        </li>
      )}
      {canManage && dropZone('root', 'Make separate entry', () => onDrop(dragId, { kind: 'root' }))}
      {canManage && dropZone('pick', 'Move to other entry…', () => onPickEntry(dragId))}
      {rows.map(({ item, depth }) => {
        const isCurrent = item.id === current;
        const isOver = over && over.id === item.id;
        const zone = isOver ? over.zone : null;
        const canTake = dragId && !banned.has(item.id);
        return (
          <li
            key={item.id}
            data-sense={item.id}
            aria-current={isCurrent ? 'true' : undefined}
            draggable={canManage}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', item.id);
              setDragId(item.id);
            }}
            onDragEnd={end}
            onDragOver={(e) => {
              if (!canTake) return;
              e.preventDefault();
              // An entry (the root) has nothing before or after it.
              const z = depth === 0 ? 'into' : zoneAt(e);
              setOver((o) => (o?.id === item.id && o.zone === z ? o : { id: item.id, zone: z }));
            }}
            onDragLeave={() => setOver((o) => (o?.id === item.id ? null : o))}
            onDrop={(e) => {
              if (!canTake) return;
              e.preventDefault();
              onDrop(dragId, { kind: depth === 0 ? 'into' : zoneAt(e), id: item.id });
              end();
            }}
            className={cn(
              'relative flex items-baseline gap-2 py-0.5 pr-3',
              canManage &&
                'cursor-grab [&_a]:underline [&_a]:decoration-dotted [&_a]:underline-offset-2 [&_.igt-sense-self]:underline [&_.igt-sense-self]:decoration-dotted [&_.igt-sense-self]:underline-offset-2',
              isCurrent && 'bg-accent/60',
              dragId === item.id && 'opacity-40',
              zone === 'into' && 'bg-accent ring-1 ring-inset ring-primary',
              zone === 'before' && 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]',
              zone === 'after' && 'shadow-[inset_0_-2px_0_0_hsl(var(--primary))]',
            )}
            style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
          >
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {tree.numberOf.get(item.id)}
            </span>
            <span className="min-w-0 truncate">
              {isCurrent ? (
                <>
                  <FormLabel
                    form={item.form}
                    index={homonyms?.get(item.id)}
                    className="igt-sense-self font-medium"
                  />
                  {item.metadata?.gloss ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {String(item.metadata.gloss)}
                    </span>
                  ) : null}
                </>
              ) : (
                <ItemLink item={item} homonyms={homonyms} itemTo={itemTo} />
              )}
            </span>
          </li>
        );
      })}
    </ul>
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
