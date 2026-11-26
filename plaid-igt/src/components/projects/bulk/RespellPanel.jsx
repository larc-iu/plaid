import { useMemo, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { notifySuccess, notifyWarning } from '@/utils/feedback';
import { buildReplacer, chainText, respellBarred } from './bulkPlan.js';
import { planRespell, applyRespell } from './bulkRunner.js';
import { notifyStopped, skippedNote, useRun, useWriter } from './bulkShared.js';
import { t } from '@ui/lib/i18n.js';
import { scopeTextClass } from '@/domain/scopeColors';
import { canManageVocabulary } from '@ui/domain/permissions.js';
import { useVocabularyHomes, vocabularyHome } from '../../../hooks/useVocabularyHomes.js';
import { useAuth } from '@/contexts/AuthContext';
import {
  ApplyBar,
  Change,
  ChangeGrid,
  Checkbox,
  MatchGroups,
  Progress,
  SelectionSummary,
  SubstitutionFields,
} from './parts.jsx';
import { usePreviewFocus } from './usePreviewFocus.js';
import { respellLabel } from '@/domain/editLabels.js';

// "3 words in 1 document, 2 morpheme forms, 1 lexicon entry respelled": what
// an apply wrote, each count shown only when there is one.
const respelledText = ({ wordsChanged, docsChanged, morphemesChanged, entriesChanged }) => {
  const v = {
    words: wordsChanged,
    docs: docsChanged,
    morphemes: morphemesChanged,
    entries: entriesChanged,
  };
  if (morphemesChanged && entriesChanged)
    return t(
      '{words, plural, one {# word} other {# words}} in {docs, plural, one {# document} other {# documents}}, {morphemes, plural, one {# morpheme form} other {# morpheme forms}}, {entries, plural, one {# lexicon entry} other {# lexicon entries}} respelled',
      v,
    );
  if (morphemesChanged)
    return t(
      '{words, plural, one {# word} other {# words}} in {docs, plural, one {# document} other {# documents}}, {morphemes, plural, one {# morpheme form} other {# morpheme forms}} respelled',
      v,
    );
  if (entriesChanged)
    return t(
      '{words, plural, one {# word} other {# words}} in {docs, plural, one {# document} other {# documents}}, {entries, plural, one {# lexicon entry} other {# lexicon entries}} respelled',
      v,
    );
  return t(
    '{words, plural, one {# word} other {# words}} in {docs, plural, one {# document} other {# documents}} respelled',
    v,
  );
};

// The confirm's sentence: the words, and the forms and entries that go with
// them when there are any.
const willRespellText = (words, morphemes, entries) => {
  const v = { words, morphemes, entries };
  if (morphemes && entries)
    return t(
      '{words, plural, one {# word} other {# words}} will be respelled, along with {morphemes, plural, one {# morpheme form} other {# morpheme forms}}, and {entries, plural, one {# lexicon entry} other {# lexicon entries}}.',
      v,
    );
  if (morphemes)
    return t(
      '{words, plural, one {# word} other {# words}} will be respelled, along with {morphemes, plural, one {# morpheme form} other {# morpheme forms}}.',
      v,
    );
  if (entries)
    return t(
      '{words, plural, one {# word} other {# words}} will be respelled, and {entries, plural, one {# lexicon entry} other {# lexicon entries}}.',
      v,
    );
  return t('{words, plural, one {# word} other {# words}} will be respelled.', v);
};

// Respell: change a word's spelling wherever it occurs, morphemes included.
const RespellChange = ({ row, includeMorphemes }) => {
  const chain = row.chain ? chainText(row.chain, includeMorphemes) : null;
  return (
    <>
      <ChangeGrid
        lines={[
          { label: t('Word'), cls: scopeTextClass('word'), from: row.old, to: row.new },
          ...(chain
            ? [
                {
                  label: t('Morphemes'),
                  cls: scopeTextClass('morpheme'),
                  from: chain.old,
                  to: chain.new,
                },
              ]
            : []),
        ]}
      />
      {row.invalid === 'empty' && (
        <p className="mt-1 text-xs text-destructive">{t('Empty word, so it will be skipped.')}</p>
      )}
      {row.invalid === 'refused' && (
        <p className="mt-1 text-xs text-destructive">
          {t('Will be skipped.')} {row.refusal}
        </p>
      )}
      {!row.invalid && includeMorphemes && row.emptiesForm && (
        <p className="mt-1 text-xs text-destructive">
          {t('Empty morpheme form, so it will be skipped.')}
        </p>
      )}
    </>
  );
};

export const RespellPanel = ({ project, projectId, client, layerInfo }) => {
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const [includeMorphemes, setIncludeMorphemes] = useState(true);
  const [includeLexicon, setIncludeLexicon] = useState(false);
  const r = useRun();
  // Respelling an entry renames it, which only a maintainer of its
  // vocabulary's project may do (core refuses anyone else), wherever they
  // stand. For a vocabulary this project borrows, that project is read, and
  // one the person cannot read is no role. The others are listed, not ticked.
  const { user } = useAuth();
  const homes = useVocabularyHomes(client, project);
  const homeOf = (vocab) => vocabularyHome(vocab, project, homes);
  const canRespellIn = (vocab) => canManageVocabulary(vocab, homeOf(vocab), user);
  // Why a kept entry is kept, by its vocabulary: who could respell it, or
  // that its project cannot be read.
  const lockedMark = (vocabId) => {
    const home = homeOf((project.vocabs || []).find((v) => v.id === vocabId));
    return home
      ? {
          label: t('maintainers only'),
          title: t('Needs a maintainer of “{name}”.', { name: home.name }),
        }
      : { label: t('read only'), title: t('This vocabulary belongs to another project.') };
  };
  const writer = useWriter(project);

  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );

  const results = usePreviewFocus([find, matchType, repl].join('\u0000'));
  const preview = async () => {
    if (!find || error) return;
    results.begin();
    const plan = await r.run(
      'Preview',
      (onProgress) =>
        planRespell(
          client,
          project,
          layerInfo,
          { find, matchType, apply, canRespellIn },
          onProgress,
        ),
      { reset: true },
    );
    if (!plan) return;
    r.setPlan({ ...plan, find, repl });
    results.shown();
    // A row that would empty a word, a form or an entry is listed, not ticked.
    r.setSelected(
      new Set(
        [
          ...plan.rows.filter((x) => !respellBarred(x, includeMorphemes)),
          ...plan.lexiconRows.filter((x) => !x.locked && !x.invalid),
        ].map((x) => x.id),
      ),
    );
  };

  const plan = r.plan;
  // A row that would empty a word, a form or an entry, or an entry of a
  // vocabulary this person does not maintain, cannot be ticked.
  const selectableRow = (x) =>
    x.kind === 'lexicon' ? !x.locked && !x.invalid : !respellBarred(x, includeMorphemes);
  // What an Apply sends: the selected rows a stopped Apply has not already
  // sent or skipped (`applied`), so the count and the confirm say what is left.
  // A barred row is never sent, even when ticked by hand.
  const selectedRows = plan
    ? plan.rows.filter(
        (x) => r.selected.has(x.id) && !x.applied && !respellBarred(x, includeMorphemes),
      )
    : [];
  const openLex = plan ? plan.lexiconRows.filter((x) => !x.locked && !x.invalid) : [];
  const selectedLex = openLex.filter((x) => r.selected.has(x.id) && !x.applied);
  const morphCount = includeMorphemes
    ? selectedRows.reduce((a, x) => a + x.morphemes.length, 0)
    : 0;
  const total = selectedRows.length + (includeLexicon ? selectedLex.length : 0);
  const lexCount = includeLexicon ? selectedLex.length : 0;

  const doApply = async () => {
    const res = await r.run('Apply', (onProgress) =>
      applyRespell(
        client,
        {
          rows: selectedRows,
          lexiconRows: selectedLex,
          versions: plan.versions,
          replan: plan.replan,
        },
        {
          writer,
          includeMorphemes,
          includeLexicon,
          label: respellLabel(plan.find, plan.repl),
          onProgress,
        },
      ),
    );
    if (!res) return;
    const skipped = skippedNote([
      [res.wordsSkipped, 'word'],
      [res.entriesSkipped, 'lexicon entry'],
    ]);
    const done = respelledText(res);
    if (res.failed) {
      // The plan stays, so Apply again sends what did not land.
      notifyStopped(res.failed, done, skipped);
      return;
    }
    if (!res.wordsChanged && !res.entriesChanged && skipped) {
      notifyWarning(skipped.trim(), t('Nothing respelled'));
    } else {
      notifySuccess(`${done}.${skipped}`, t('Respelled'));
    }
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <SubstitutionFields
          {...{ find, setFind, matchType, setMatchType, repl, setRepl }}
          onEnter={preview}
        />
        {error && (
          <p className="text-sm text-destructive">{t('Check your regex: {error}', { error })}</p>
        )}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={includeMorphemes} onChange={setIncludeMorphemes} />
            {t('Also respell morpheme forms')}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={includeLexicon} onChange={setIncludeLexicon} />
            {t('Also respell lexicon entries')}
          </label>
          <Button className="ml-auto" onClick={preview} disabled={r.busy || !find || !!error}>
            {r.busy && !plan ? t('Searching…') : t('Preview')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'Whole words are respelled in the baseline text. Each keeps its morphemes, glosses, and lexicon links. Text outside words (punctuation between them, gaps) is left alone.',
          )}
        </p>
      </div>
      <Progress text={r.progress} startedAt={r.startedAt} />
      {plan && (
        <>
          <ApplyBar
            focusRef={results.ref}
            count={total}
            busy={r.busy}
            onApply={doApply}
            summary={willRespellText(selectedRows.length, morphCount, lexCount)}
          >
            <SelectionSummary
              selectable={selectableRow}
              rows={includeLexicon ? [...plan.rows, ...plan.lexiconRows] : plan.rows}
              selected={r.selected}
              setSelected={r.setSelected}
            />
          </ApplyBar>
          {plan.rows.length === 0 && plan.lexiconRows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('No matching words.')}
            </p>
          )}
          <MatchGroups
            selectable={selectableRow}
            projectId={projectId}
            rows={plan.rows}
            selected={r.selected}
            toggle={r.toggle}
            toggleMany={r.toggleMany}
            renderRow={(row) => <RespellChange row={row} includeMorphemes={includeMorphemes} />}
          />
          {plan.lexiconRows.length > 0 && (
            <div className={cn('rounded-lg border bg-card', !includeLexicon && 'opacity-60')}>
              <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
                <Checkbox
                  checked={openLex.length > 0 && selectedLex.length === openLex.length}
                  indeterminate={selectedLex.length > 0}
                  onChange={(v) =>
                    r.toggleMany(
                      openLex.map((x) => x.id),
                      v,
                    )
                  }
                  disabled={!includeLexicon || openLex.length === 0}
                />
                <span className="text-sm font-medium">{t('Lexicon entries')}</span>
                <span className="text-xs text-muted-foreground">
                  {includeLexicon
                    ? t('{on} of {n, plural, one {# entry} other {# entries}} selected', {
                        on: selectedLex.length,
                        n: plan.lexiconRows.length,
                      })
                    : t(
                        '{on} of {n, plural, one {# entry} other {# entries}} selected (not included)',
                        { on: selectedLex.length, n: plan.lexiconRows.length },
                      )}
                </span>
              </div>
              <div className="divide-y">
                {plan.lexiconRows.map((x) => (
                  <div key={x.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={!x.locked && !x.invalid && r.selected.has(x.id)}
                      onChange={(v) => r.toggle(x.id, v)}
                      disabled={!includeLexicon || x.locked || !!x.invalid}
                    />
                    <Change from={x.old} to={x.new} />
                    <span className="text-xs text-muted-foreground">
                      <span dir="auto">{x.vocabName}</span>
                      {x.locked && (
                        <span title={lockedMark(x.vocabId).title}>
                          {' · '}
                          {lockedMark(x.vocabId).label}
                        </span>
                      )}
                    </span>
                    {x.invalid === 'empty' && (
                      <span className="text-xs text-destructive">
                        {t('Empty form, so it will be skipped.')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ---- field ----------------------------------------------------------------------
