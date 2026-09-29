import { useMemo, useState } from 'react';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { notifySuccess, notifyWarning } from '@/utils/feedback';
import { buildReplacer, chainText } from './bulkPlan.js';
import { planRespell, applyRespell } from './bulkRunner.js';
import { plural, skippedNote, useRun } from './bulkShared.js';
import { scopeTextClass } from '@/domain/scopeColors';
import { canManageVocabulary } from '@ui/domain/permissions.js';
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

// Respell: change a word's spelling wherever it occurs, morphemes included.
const RespellChange = ({ row, includeMorphemes }) => {
  const chain = row.chain ? chainText(row.chain, includeMorphemes) : null;
  return (
    <ChangeGrid
      lines={[
        { label: 'Word', cls: scopeTextClass('word'), from: row.old, to: row.new },
        ...(chain
          ? [
              {
                label: 'Morphemes',
                cls: scopeTextClass('morpheme'),
                from: chain.old,
                to: chain.new,
              },
            ]
          : []),
      ]}
    />
  );
};

export const RespellPanel = ({ project, projectId, client, layerInfo }) => {
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const [includeMorphemes, setIncludeMorphemes] = useState(true);
  const [includeLexicon, setIncludeLexicon] = useState(true);
  const r = useRun();
  // Respelling an entry renames it, which only its vocabulary's maintainers
  // may do (core refuses anyone else). The others are listed, not ticked.
  const { user } = useAuth();
  const canRespellIn = (vocab) => canManageVocabulary(vocab, user);

  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );

  const preview = async () => {
    if (!find || error) return;
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
    r.setSelected(
      new Set([...plan.rows, ...plan.lexiconRows.filter((x) => !x.locked)].map((x) => x.id)),
    );
  };

  const plan = r.plan;
  const selectedRows = plan ? plan.rows.filter((x) => r.selected.has(x.id)) : [];
  const openLex = plan ? plan.lexiconRows.filter((x) => !x.locked) : [];
  const selectedLex = openLex.filter((x) => r.selected.has(x.id));
  const morphCount = includeMorphemes
    ? selectedRows.reduce((a, x) => a + x.morphemes.length, 0)
    : 0;
  const total = selectedRows.length + (includeLexicon ? selectedLex.length : 0);

  const doApply = async () => {
    const res = await r.run('Apply', () =>
      applyRespell(
        client,
        {
          rows: selectedRows,
          lexiconRows: selectedLex,
          versions: plan.versions,
          replan: plan.replan,
        },
        {
          includeMorphemes,
          includeLexicon,
          label: `Respell “${plan.find}” → “${plan.repl}”`,
        },
      ),
    );
    if (!res) return;
    const skipped = skippedNote([
      [res.wordsSkipped, 'word'],
      [res.entriesSkipped, 'lexicon entry', 'lexicon entries'],
    ]);
    if (!res.wordsChanged && !res.entriesChanged && skipped) {
      notifyWarning(skipped.trim(), 'Nothing respelled');
    } else {
      notifySuccess(
        `${plural(res.wordsChanged, 'word')} in ${plural(res.docsChanged, 'document')}` +
          (res.morphemesChanged ? `, ${plural(res.morphemesChanged, 'morpheme form')}` : '') +
          (res.entriesChanged
            ? `, ${plural(res.entriesChanged, 'lexicon entry', 'lexicon entries')}`
            : '') +
          ' respelled.' +
          skipped,
        'Respelled',
      );
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
        {error && <p className="text-sm text-destructive">Check your regex: {error}</p>}
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={includeMorphemes} onChange={setIncludeMorphemes} />
            Also respell morpheme forms
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={includeLexicon} onChange={setIncludeLexicon} />
            Also respell lexicon entries
          </label>
          <Button className="ml-auto" onClick={preview} disabled={r.busy || !find || !!error}>
            {r.busy && !plan ? 'Searching…' : 'Preview'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Whole words are respelled in the baseline text. Each keeps its morphemes, glosses, and
          lexicon links. Text outside words (punctuation between them, gaps) is left alone.
        </p>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          <ApplyBar
            count={total}
            busy={r.busy}
            onApply={doApply}
            summary={`${plural(selectedRows.length, 'word')} will be respelled${
              morphCount ? `, along with ${plural(morphCount, 'morpheme form')}` : ''
            }${
              includeLexicon && selectedLex.length
                ? `, and ${plural(selectedLex.length, 'lexicon entry', 'lexicon entries')}`
                : ''
            }.`}
          >
            <SelectionSummary
              rows={[...plan.rows, ...plan.lexiconRows]}
              selected={r.selected}
              setSelected={r.setSelected}
            />
          </ApplyBar>
          {plan.rows.length === 0 && plan.lexiconRows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching words.</p>
          )}
          <MatchGroups
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
                <span className="text-sm font-medium">Lexicon entries</span>
                <span className="text-xs text-muted-foreground">
                  {selectedLex.length} of {plural(plan.lexiconRows.length, 'entry', 'entries')}{' '}
                  selected{!includeLexicon && ' (not included)'}
                </span>
              </div>
              <div className="divide-y">
                {plan.lexiconRows.map((x) => (
                  <div key={x.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={!x.locked && r.selected.has(x.id)}
                      onChange={(v) => r.toggle(x.id, v)}
                      disabled={!includeLexicon || x.locked}
                    />
                    <Change from={x.old} to={x.new} />
                    <span className="text-xs text-muted-foreground">
                      {x.vocabName}
                      {x.locked && ' · maintainers only'}
                    </span>
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
