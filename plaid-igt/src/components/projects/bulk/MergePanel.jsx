import { Fragment, useEffect, useMemo, useState } from 'react';
import { PROVENANCE_KEYS } from '@larc-iu/plaid-client';
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
import { ExamplesPanel } from '@/components/vocabularies/DictionaryPanels';
import { normalizeVocabFields, editableMetadata, FIELD_TYPES } from '@/domain/vocabFields';
import { fieldDisplayName, morphTypeDisplayLabel } from '@/domain/vocabFieldLabels';
import { itemLabel, mergeMorphType, planMergeRefs, refIds } from '@/domain/vocabDictionary';
import { metadataUpdates } from '@/domain/metadataPatch';
import { readVocabFields } from '@/domain/igtConfig';
import { planMerge, applyMerge } from './bulkRunner.js';
import { useRun } from './bulkShared.js';
import { t, tx } from '@ui/lib/i18n.js';
import { ApplyBar, Checkbox, Progress } from './parts.jsx';
import { usePreviewFocus } from './usePreviewFocus.js';
import { textIncludes } from '@ui/domain/collation.js';
import { canManageVocabulary } from '@ui/domain/permissions.js';
import { useVocabularyHomes, vocabularyHome } from '../../../hooks/useVocabularyHomes.js';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { useAuth } from '@/contexts/AuthContext';
import { readVocabulary } from '@/domain/vocabCache';
import { isChangedElsewhere } from '@ui/lib/errors.js';

// Merge entries: fold one lexicon entry into another, relinking its uses.
// Provenance keys are bookkeeping rather than content. The structural keys
// (the sense tree, the examples, the import identity) are set apart by
// editableMetadata, and the two the panel draws itself are drawn below.
const strong = (c) => <strong>{c}</strong>;

const isBookkeepingKey = (k) => PROVENANCE_KEYS.includes(k);

// The whole of one lexicon entry (minus its attestations): every configured
// field in schema order, then any other content the entry carries (custom
// keys, a FLEx homograph number), then its examples as the entry screen shows
// them, promoted and imported alike. Shown under a ticked row so what survives
// and what is lost in a merge is plain to see: the survivor takes the others'
// promoted examples (planMergeRefs). `nameOf` names another entry of the
// vocabulary, for the fields that refer to one.
const EntryDetail = ({ item, fields, nameOf, client }) => {
  const meta = item.metadata || {};
  const known = new Set(fields.map((f) => f.name));
  const extras = Object.keys(editableMetadata(meta)).filter(
    (k) => !known.has(k) && !isBookkeepingKey(k),
  );
  const homograph = Number(meta.homograph) || 0;
  const show = (v) =>
    v == null || String(v).trim() === '' ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      String(v)
    );
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5 text-sm">
        {fields.map((f) => (
          <Fragment key={f.name}>
            <dt className="text-xs text-muted-foreground">{fieldDisplayName(f.name)}</dt>
            <dd>
              {f.type === FIELD_TYPES.ITEM
                ? show(refIds(item, f).map(nameOf).filter(Boolean).join(', '))
                : show(meta[f.name])}
            </dd>
          </Fragment>
        ))}
        {extras.map((k) => (
          <Fragment key={k}>
            <dt className="text-xs text-muted-foreground">{fieldDisplayName(k)}</dt>
            <dd>{show(typeof meta[k] === 'object' ? JSON.stringify(meta[k]) : meta[k])}</dd>
          </Fragment>
        ))}
        {homograph > 0 && (
          <>
            <dt className="text-xs text-muted-foreground">{t('FLEx homograph')}</dt>
            <dd>{homograph}</dd>
          </>
        )}
      </dl>
      <ExamplesPanel item={item} client={client} linkedTokenIds={null} canEdit={false} />
    </div>
  );
};

export const MergePanel = ({ project, client }) => {
  const vocabs = project.vocabs || [];
  const [vocabId, setVocabId] = useState(vocabs[0]?.id ?? '');
  const [items, setItems] = useState(null);
  const [fields, setFields] = useState([]);
  // A merge deletes the merged entries, which only a maintainer of the
  // vocabulary's project may do (core refuses anyone else), wherever they
  // stand. For a vocabulary this project borrows, that project is read, and
  // one the person cannot read is no role.
  const { user } = useAuth();
  const homes = useVocabularyHomes(client, project);
  const [layer, setLayer] = useState(null);
  const home = layer ? vocabularyHome(layer, project, homes) : null;
  const canMerge = !!layer && canManageVocabulary(layer, home, user);
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
    setLayer(null);
    if (!vocabId) return undefined;
    readVocabulary(client, vocabId)
      .then((read) => {
        if (cancelled) return;
        setLayer(read);
        setItems(read.items || []);
        setFields(normalizeVocabFields(readVocabFields(read.config)));
      })
      .catch((err) => {
        console.error('Load vocabulary failed:', err);
        if (!cancelled) notifyError(humanizeError(err), t('Failed to load the vocabulary'));
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
    const list = q ? items.filter((it) => textIncludes(it.form || '', q)) : items;
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
  // What type the survivor ends with (Luke 2026-11-01): an untyped survivor
  // takes the one type its losers go by, else the losers' morphemes go by
  // the survivor's.
  const typing =
    items && survivor && losers.length ? mergeMorphType(items, survivor, losers) : null;

  const results = usePreviewFocus([...chosen, survivor].join(' '));
  const preview = async () => {
    if (!canMerge || !survivor || losers.length === 0) return;
    results.begin();
    const plan = await r.run('Preview', () => planMerge(client, vocabId, losers, survivor), {
      reset: true,
    });
    if (plan) {
      r.setPlan(plan);
      results.shown();
    }
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

  // The entries read again after a merge refused because one of them changed
  // or went: the list, the ticks and the survivor follow what is there now.
  const reloadAfterRefusal = async () => {
    let read;
    try {
      read = await readVocabulary(client, vocabId);
    } catch (err) {
      console.error('Load vocabulary failed:', err);
      return;
    }
    const fresh = read.items || [];
    const ids = new Set(fresh.map((it) => it.id));
    setItems(fresh);
    setChosen((prev) => new Set([...prev].filter((id) => ids.has(id))));
    if (survivor && !ids.has(survivor)) setSurvivor(null);
    r.setPlan(null);
  };

  const doApply = async () => {
    if (!canMerge) return;
    const survivorItem = itemById.get(survivor);
    // Written out, as the History entry and the toast carry it: "dog 1".
    const survivorName = itemLabel(survivorItem, numbers);
    let now = null;
    let refused = false;
    const res = await r.run('Apply', async () => {
      // The vocabulary's own references to the losers (senses, reference
      // fields) follow the links to the survivor. They are planned against
      // the entries read now, so a reference made since this list was drawn
      // follows too. planMergeRefs returns the whole map each entry ends up
      // with. The write is the patch against what it carries, so a
      // vocabulary with a thousand references to a merged entry repoints
      // them in one request.
      now = (await readVocabulary(client, vocabId)).items || [];
      const refPlans = planMergeRefs(now, fields, survivor, losers);
      const refUpdates = metadataUpdates(refPlans, new Map(now.map((it) => [it.id, it.metadata])));
      // The links this person can see, counted again now: the merge moves
      // the ones in projects they cannot open as well, and the toast says
      // how many of those there were.
      const seen = await planMerge(client, vocabId, losers, survivor);
      try {
        const out = await applyMerge(
          client,
          { refUpdates },
          {
            survivorId: survivor,
            loserIds: losers,
            // i18n-ignore: an audit label, stored on the server
            label: `Merge ${losers.length.toLocaleString()} ${losers.length === 1 ? 'lexicon entry' : 'lexicon entries'} into “${survivorName}”`,
          },
        );
        return { ...out, refPlans, seen };
      } catch (err) {
        refused = isChangedElsewhere(err);
        throw err;
      }
    });
    if (!res) {
      if (refused) await reloadAfterRefusal();
      return;
    }
    // The links moved that this person could not count: every link moved,
    // less the ones counted that were moved rather than dropped as
    // duplicates.
    const hidden = Math.max(0, res.linksMoved - (res.seen.links - res.seen.duplicates));
    const said = [
      t('{n, plural, one {# entry} other {# entries}} merged.', { n: res.entriesRemoved }),
      hidden
        ? t(
            '{n, plural, one {# link} other {# links}} moved to “{name}”, {hidden} of them in projects you cannot open.',
            { n: res.linksMoved, name: survivorName, hidden },
          )
        : t('{n, plural, one {# link} other {# links}} moved to “{name}”.', {
            n: res.linksMoved,
            name: survivorName,
          }),
    ];
    if (res.duplicatesRemoved)
      said.push(
        t('{n, plural, one {# duplicate link} other {# duplicate links}} removed.', {
          n: res.duplicatesRemoved,
        }),
      );
    if (res.entriesRepointed)
      said.push(
        t('{n, plural, one {# entry now points} other {# entries now point}} at it.', {
          n: res.entriesRepointed,
        }),
      );
    notifySuccess(said.join(' '), t('Merged'));
    // The maps the plan ends at, for the list on screen. The WRITE was the
    // patch against what each entry carried.
    const patched = new Map(res.refPlans.map((p) => [p.id, p.metadata]));
    setItems(
      now
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
        {t('This project has no linked vocabulary.')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          {vocabs.length > 1 && (
            <div className="flex flex-col gap-1">
              <Label>{t('Vocabulary')}</Label>
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
            <Label htmlFor="bulk-merge-filter">{t('Find entries')}</Label>
            <Input
              id="bulk-merge-filter"
              compose
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('filter by form')}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'Tick the entries to merge and choose which one survives. Every word and morpheme linked to the others is re-linked to the survivor. The survivor’s fields are kept, it takes the others’ examples from documents, and the other entries are deleted.',
          )}
        </p>
        {items && !canMerge && (
          <Notice tone="info">
            {home
              ? tx('Only a maintainer of “<span>{name}</span>” can merge its entries.', {
                  name: home.name,
                  span: (c) => <span dir="auto">{c}</span>,
                })
              : t('This vocabulary belongs to another project.')}
          </Notice>
        )}
      </div>

      {items && (
        <div className="rounded-lg border bg-card">
          <div className="grid grid-cols-[3.5rem_3rem_1fr] items-center border-b bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="text-center">{t('Merge')}</span>
            <span className="text-center">{t('Keep')}</span>
            <span>{t('Entry')}</span>
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
                    aria-label={
                      idx
                        ? t('Merge {form} {index}', { form: it.form, index: idx })
                        : t('Merge {form}', { form: it.form })
                    }
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
                    title={t('Keep this entry')}
                  />
                  <span className="min-w-0 truncate">
                    <FormLabel form={it.form} index={idx} className="font-medium" />
                    {!on && inlineLine(it) && (
                      <span className="ml-2 text-xs text-muted-foreground">{inlineLine(it)}</span>
                    )}
                  </span>
                  {on && (
                    <div className="col-start-3 pb-1 pt-1">
                      <EntryDetail item={it} fields={fields} nameOf={nameOf} client={client} />
                    </div>
                  )}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t('No entries.')}
              </p>
            )}
            {items.length > 200 && shown.length === 200 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t('Showing the first 200. Narrow the filter to find others.')}
              </p>
            )}
          </div>
        </div>
      )}

      {chosen.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
          <span>
            {survivor
              ? tx(
                  '{n, plural, one {# entry} other {# entries}} ticked, keeping <strong>{entry}</strong>',
                  {
                    n: chosen.size,
                    entry: (
                      <FormLabel
                        form={itemById.get(survivor)?.form}
                        index={numbers.get(survivor)}
                      />
                    ),
                    strong,
                  },
                )
              : t('{n, plural, one {# entry} other {# entries}} ticked', { n: chosen.size })}
          </span>
          <Button
            className="ml-auto"
            variant="outline"
            onClick={preview}
            disabled={!canMerge || r.busy || !survivor || losers.length === 0}
          >
            {r.busy && !plan ? t('Counting links…') : t('Preview')}
          </Button>
        </div>
      )}
      <Progress text={r.progress} startedAt={r.startedAt} />
      {plan && survivor && (
        <ApplyBar
          focusRef={results.ref}
          count={losers.length}
          busy={r.busy}
          onApply={doApply}
          summary={tx(
            '{n, plural, one {# entry} other {# entries}} will be merged into “{entry}”: their links move to it, and the merged entries are deleted.',
            {
              n: losers.length,
              entry: (
                <FormLabel form={itemById.get(survivor)?.form} index={numbers.get(survivor)} />
              ),
            },
          )}
        >
          <span className="text-sm">
            {tx(
              '{losers} → <strong>{entry}</strong>: {n, plural, one {# link} other {# links}} in {docs, plural, one {# document} other {# documents}} will follow.',
              {
                losers: losers.map((id, i) => (
                  <Fragment key={id}>
                    {i > 0 && ', '}
                    <FormLabel form={itemById.get(id)?.form} index={numbers.get(id)} />
                  </Fragment>
                )),
                entry: (
                  <FormLabel form={itemById.get(survivor)?.form} index={numbers.get(survivor)} />
                ),
                n: plan.links,
                docs: plan.docs,
                strong,
              },
            )}
          </span>
          {typing?.take && (
            <span className="block text-sm">
              {tx('“{entry}” takes the type {type}.', {
                entry: (
                  <FormLabel form={itemById.get(survivor)?.form} index={numbers.get(survivor)} />
                ),
                type: morphTypeDisplayLabel(typing.take),
              })}
            </span>
          )}
          {typing?.differs && (
            <span className="block text-sm">
              {t('The merged entries’ morphemes will go by the survivor’s type.')}
            </span>
          )}
        </ApplyBar>
      )}
    </div>
  );
};

// ---- the tab -------------------------------------------------------------------
