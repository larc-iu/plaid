import { Fragment, useEffect, useMemo, useState } from 'react';
import { Merge } from 'lucide-react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';
import { cn } from '@ui/lib/utils';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { buildItemNumbers } from '@/domain/vocabDictionary';
import { FormLabel } from '@/components/vocabularies/FormLabel';
import {
  normalizeVocabFields,
  humanizeFieldName,
  editableMetadata,
  FIELD_TYPES,
} from '@/domain/vocabFields';
import { itemLabel, planMergeRefs, refIds } from '@/domain/vocabDictionary';
import { readVocabFields } from '@/domain/igtConfig';
import { planMerge, applyMerge } from './bulkRunner.js';
import { plural, useRun } from './bulkShared.js';
import { ApplyBar, Checkbox, Progress } from './parts.jsx';

// Merge entries: fold one lexicon entry into another, relinking its uses.
// Provenance keys are bookkeeping rather than content. The structural keys
// (the sense tree, the examples, the import identity) are set apart by
// editableMetadata, and the two the panel draws itself are drawn below.
const isBookkeepingKey = (k) => k.startsWith('prov');

// The whole of one lexicon entry (minus its attestations): every configured
// field in schema order, then any other content the entry carries (custom
// keys, a FLEx homograph number, example sentences). Shown under a ticked row
// so what survives and what is lost in a merge is plain to see. `nameOf`
// names another entry of the vocabulary, for the fields that refer to one.
export const EntryDetail = ({ item, fields, nameOf }) => {
  const meta = item.metadata || {};
  const known = new Set(fields.map((f) => f.name));
  const extras = Object.keys(editableMetadata(meta)).filter(
    (k) => !known.has(k) && !isBookkeepingKey(k),
  );
  const examples = Array.isArray(meta.examples) ? meta.examples.filter((ex) => ex?.text) : [];
  const homograph = Number(meta.homograph) || 0;
  const show = (v) =>
    v == null || String(v).trim() === '' ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      String(v)
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm">
      {fields.map((f) => (
        <Fragment key={f.name}>
          <dt className="text-xs text-muted-foreground">{humanizeFieldName(f.name)}</dt>
          <dd>
            {f.type === FIELD_TYPES.ITEM
              ? show(refIds(item, f).map(nameOf).filter(Boolean).join(', '))
              : show(meta[f.name])}
          </dd>
        </Fragment>
      ))}
      {extras.map((k) => (
        <Fragment key={k}>
          <dt className="text-xs text-muted-foreground">{humanizeFieldName(k)}</dt>
          <dd>{show(typeof meta[k] === 'object' ? JSON.stringify(meta[k]) : meta[k])}</dd>
        </Fragment>
      ))}
      {homograph > 0 && (
        <>
          <dt className="text-xs text-muted-foreground">FLEx homograph</dt>
          <dd>{homograph}</dd>
        </>
      )}
      {examples.length > 0 && (
        <>
          <dt className="text-xs text-muted-foreground">Examples</dt>
          <dd>
            <ul className="flex flex-col gap-0.5">
              {examples.map((ex, i) => (
                <li key={i}>
                  {ex.text}
                  {ex.translation && (
                    <span className="block text-xs text-muted-foreground">{ex.translation}</span>
                  )}
                </li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  );
};

export const MergePanel = ({ project, client }) => {
  const vocabs = project.vocabs || [];
  const [vocabId, setVocabId] = useState(vocabs[0]?.id ?? '');
  const [items, setItems] = useState(null);
  const [fields, setFields] = useState([]);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState(() => new Set());
  const [survivor, setSurvivor] = useState(null);
  const r = useRun();

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setChosen(new Set());
    setSurvivor(null);
    r.setPlan(null);
    if (!vocabId) return undefined;
    client.vocabLayers
      .get(vocabId, true)
      .then((layer) => {
        if (cancelled) return;
        setItems(layer.items || []);
        setFields(normalizeVocabFields(readVocabFields(layer.config)));
      })
      .catch((err) => {
        console.error('Load vocabulary failed:', err);
        if (!cancelled) notifyError(humanizeError(err, 'Could not load the vocabulary.'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vocabId, client]);

  const numbers = useMemo(() => buildItemNumbers(items || []), [items]);
  const itemById = useMemo(() => new Map((items || []).map((it) => [it.id, it])), [items]);
  // An entry named the way the vocabulary names it: form and number.
  const nameOf = (id) => itemLabel(itemById.get(id), numbers);
  const shown = useMemo(() => {
    if (!items) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? items.filter((it) => (it.form || '').toLowerCase().includes(q)) : items;
    return [...list].sort((a, b) => (a.form || '').localeCompare(b.form || '')).slice(0, 200);
  }, [items, filter]);
  const pick = (id, on) => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    if (on && survivor == null) setSurvivor(id);
    if (!on && survivor === id) setSurvivor(null);
    r.setPlan(null);
  };

  const losers = [...chosen].filter((id) => id !== survivor);

  const preview = async () => {
    if (!survivor || losers.length === 0) return;
    const plan = await r.run(
      'Preview',
      (onProgress) => planMerge(client, project, vocabId, losers, onProgress),
      { reset: true },
    );
    if (plan) r.setPlan(plan);
  };

  const plan = r.plan;
  // The at-a-glance line for an unticked entry: its inline fields (the ones
  // the vocabulary table shows as columns), values only.
  const inlineLine = (it) =>
    fields
      .filter((f) => f.inline)
      .map((f) => it.metadata?.[f.name])
      .filter((v) => v != null && String(v).trim() !== '')
      .join(' · ');

  const doApply = async () => {
    const survivorItem = itemById.get(survivor);
    // The vocabulary's own references to the losers (senses, reference
    // fields) follow the links to the survivor.
    const refPatches = planMergeRefs(items || [], fields, survivor, losers);
    const res = await r.run('Apply', () =>
      applyMerge(
        client,
        { links: plan.links, refPatches },
        {
          survivorId: survivor,
          loserIds: losers,
          label: `Merge ${plural(losers.length, 'lexicon entry', 'lexicon entries')} into “${survivorItem?.form ?? ''}”`,
        },
      ),
    );
    if (!res) return;
    notifySuccess(
      `${plural(res.entriesRemoved, 'entry', 'entries')} merged. ${plural(res.linksMoved, 'link')} moved to “${survivorItem?.form ?? ''}”.` +
        (res.entriesRepointed
          ? ` ${plural(res.entriesRepointed, 'entry', 'entries')} now ${
              res.entriesRepointed === 1 ? 'points' : 'point'
            } at it.`
          : ''),
      'Merged',
    );
    const patched = new Map(refPatches.map((p) => [p.id, p.metadata]));
    setItems((prev) =>
      (prev || [])
        .filter((it) => !chosen.has(it.id) || it.id === survivor)
        .map((it) => (patched.has(it.id) ? { ...it, metadata: patched.get(it.id) } : it)),
    );
    setChosen(new Set());
    setSurvivor(null);
    r.setPlan(null);
  };

  if (vocabs.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This project has no linked vocabulary.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          {vocabs.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label>Vocabulary</Label>
              <Select value={vocabId} onValueChange={setVocabId}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vocabs.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="bulk-merge-filter">Find entries</Label>
            <Input
              id="bulk-merge-filter"
              compose
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by form"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Tick the entries to merge and choose which one survives. Every word and morpheme linked to
          the others is re-linked to the survivor; the survivor’s own fields are kept as they are
          and the other entries are deleted.
        </p>
      </div>

      {items && (
        <div className="rounded-lg border bg-card">
          <div className="grid grid-cols-[3.5rem_3rem_1fr] items-center border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="text-center">Merge</span>
            <span className="text-center">Keep</span>
            <span>Entry</span>
          </div>
          <div className="divide-y">
            {shown.map((it) => {
              const on = chosen.has(it.id);
              const idx = numbers.get(it.id);
              return (
                <div
                  key={it.id}
                  className={cn(
                    'grid grid-cols-[3.5rem_3rem_1fr] items-center px-3 py-1.5 text-sm',
                    on && 'bg-muted/30',
                  )}
                >
                  <Checkbox
                    checked={on}
                    onChange={(v) => pick(it.id, v)}
                    className="h-4 w-4 cursor-pointer justify-self-center accent-primary"
                  />
                  <input
                    type="radio"
                    name="bulk-survivor"
                    checked={survivor === it.id}
                    disabled={!on}
                    onChange={() => {
                      setSurvivor(it.id);
                      r.setPlan(null);
                    }}
                    className="justify-self-center accent-primary disabled:opacity-30"
                    title="Keep this entry"
                  />
                  <span className="min-w-0 truncate">
                    <FormLabel form={it.form} index={idx} className="font-medium" />
                    {!on && inlineLine(it) && (
                      <span className="ml-2 text-xs text-muted-foreground">{inlineLine(it)}</span>
                    )}
                  </span>
                  {on && (
                    <div className="col-start-3 pb-1 pt-1">
                      <EntryDetail item={it} fields={fields} nameOf={nameOf} />
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No entries.</p>
            )}
            {items.length > 200 && shown.length === 200 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Showing the first 200; narrow the filter to find others.
              </p>
            )}
          </div>
        </div>
      )}

      {chosen.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
          <span>
            {plural(chosen.size, 'entry', 'entries')} ticked
            {survivor && (
              <>
                , keeping <strong>{itemById.get(survivor)?.form}</strong>
              </>
            )}
          </span>
          <Button
            className="ml-auto"
            variant="outline"
            onClick={preview}
            disabled={r.busy || !survivor || losers.length === 0}
          >
            {r.busy && !plan ? 'Counting links…' : 'Preview'}
          </Button>
        </div>
      )}
      <Progress text={r.progress} />
      {plan && survivor && (
        <ApplyBar
          count={losers.length}
          busy={r.busy}
          onApply={doApply}
          summary={`${plural(losers.length, 'entry', 'entries')} will be merged into “${itemById.get(survivor)?.form}”: ${plural(plan.links.length, 'link')} in ${plural(new Set(plan.links.map((l) => l.docId)).size, 'document')} move to it, and the merged entries are deleted.`}
        >
          <span className="text-sm">
            {losers.map((id) => itemById.get(id)?.form).join(', ')} →{' '}
            <strong>{itemById.get(survivor)?.form}</strong>:{' '}
            {plural(plan.links.length, 'linked word or morpheme', 'linked words and morphemes')} in{' '}
            {plural(new Set(plan.links.map((l) => l.docId)).size, 'document')} will follow.
          </span>
        </ApplyBar>
      )}
    </div>
  );
};

// ---- the tab -------------------------------------------------------------------
