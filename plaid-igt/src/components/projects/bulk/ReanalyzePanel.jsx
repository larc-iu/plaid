import { Fragment, useMemo, useState } from 'react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils';
import { notifySuccess, notifyError, notifyWarning } from '@/utils/feedback';
import { analysisViolations, governedFields } from '@/domain/tagsets';
import { tallyCandidates, analysisLabel, cardRowsFor } from './bulkPlan.js';
import { planReanalyze, applyReanalyze } from './bulkRunner.js';
import { AnalysisCard } from './AnalysisCard.jsx';
import { plural, useRun } from './bulkShared.js';
import { ApplyBar, MatchGroups, Progress, SelectionSummary } from './parts.jsx';

// Re-analyze: replace one analysis of a word form with another everywhere.
export const ReanalyzePanel = ({ project, projectId, client, layerInfo }) => {
  const [form, setForm] = useState('');
  const [targetSig, setTargetSig] = useState(null);
  const r = useRun();
  const cardRows = useMemo(() => cardRowsFor(layerInfo, project), [layerInfo, project]);

  // Re-analyze spreads ONE analysis to every occurrence, so a single off-tagset
  // value in the chosen target lands everywhere at once. Judge the analysis
  // before any of it is written, rather than each row as field-replace does.
  const tagsetFor = useMemo(() => {
    const by = new Map(
      governedFields(layerInfo, project?.config).map((g) => [`${g.scope}:${g.field}`, g.tagset]),
    );
    return (scope, field) => by.get(`${scope}:${field}`) ?? null;
  }, [layerInfo, project?.config]);

  const preview = async () => {
    if (!form.trim()) return;
    setTargetSig(null);
    const plan = await r.run(
      'Preview',
      (onProgress) => planReanalyze(client, project, layerInfo, form.trim(), onProgress),
      { reset: true },
    );
    if (!plan) return;
    const candidates = tallyCandidates(plan.rows);
    r.setPlan({ ...plan, form: form.trim(), candidates });
    const sig = candidates[0]?.signature ?? null;
    setTargetSig(sig);
    r.setSelected(new Set(plan.rows.filter((x) => x.signature !== sig).map((x) => x.id)));
  };

  const plan = r.plan;
  const target = plan?.candidates.find((c) => c.signature === targetSig) ?? null;
  const targetBad = target ? analysisViolations(target.analysis, tagsetFor) : [];
  const targetName = target
    ? `Analysis ${plan.candidates.findIndex((c) => c.signature === targetSig) + 1}`
    : '';
  const label = (a) => analysisLabel(a, plan?.itemFormById);

  // Switching the target re-derives the default selection: everything that
  // doesn't already carry it.
  const chooseTarget = (sig) => {
    setTargetSig(sig);
    r.setSelected(new Set(plan.rows.filter((x) => x.signature !== sig).map((x) => x.id)));
  };

  const selectedRows = plan
    ? plan.rows.filter((x) => r.selected.has(x.id) && x.signature !== targetSig)
    : [];

  const doApply = async () => {
    if (!target || targetBad.length) return;
    const res = await r.run('Apply', () =>
      applyReanalyze(
        client,
        { rows: selectedRows, docs: plan.docs },
        {
          analysis: target.analysis,
          label: `Re-analyze “${plan.form}” as ${label(target.analysis)}`,
          onError: (msg) => notifyError(msg, 'Re-analyze'),
        },
      ),
    );
    if (!res) return;
    if (res.failedDoc) {
      notifyWarning(
        `${plural(res.changed, 'occurrence')} re-analyzed before “${res.failedDoc}” failed. The remaining documents were not changed.`,
        'Stopped early',
      );
    } else {
      notifySuccess(
        `${plural(res.changed, 'occurrence')} of “${plan.form}” re-analyzed.`,
        'Re-analyzed',
      );
    }
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="bulk-form">Word form</Label>
            <Input
              id="bulk-form"
              compose
              value={form}
              onChange={(e) => setForm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && preview()}
              placeholder="exactly as it appears in the baseline"
            />
          </div>
          <Button onClick={preview} disabled={r.busy || !form.trim()}>
            {r.busy && !plan ? 'Searching…' : 'Find occurrences'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Lists every occurrence of the word with the analysis it carries now. Pick the analysis
          that should win; the ticked occurrences get it (segmentation, glosses, and links),
          replacing whatever they had.
        </p>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          {plan.candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {plan.rows.length === 0
                ? `No occurrences of “${plan.form}”.`
                : `“${plan.form}” occurs ${plural(plan.rows.length, 'time')}, but none of them is analyzed yet. Analyze one in a document first; then it can be applied to the rest here.`}
            </p>
          ) : (
            <div className="rounded-lg border bg-card p-4">
              <p className="mb-2 text-sm font-medium">Apply this analysis</p>
              <div className="flex flex-col gap-2">
                {plan.candidates.map((c, i) => (
                  <label
                    key={c.signature}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 hover:bg-muted/30',
                      targetSig === c.signature && 'border-primary bg-primary/5',
                    )}
                  >
                    <input
                      type="radio"
                      name="bulk-analysis"
                      checked={targetSig === c.signature}
                      onChange={() => chooseTarget(c.signature)}
                      className="mt-1 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-baseline gap-2">
                        <span className="text-sm font-semibold">Analysis {i + 1}</span>
                        <span className="text-xs text-muted-foreground">
                          {plural(c.count, 'occurrence')}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <AnalysisCard
                          word={plan.form}
                          analysis={c.analysis}
                          rows={cardRows}
                          itemFormById={plan.itemFormById}
                        />
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
          {targetBad.length > 0 && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              This analysis holds{' '}
              {targetBad.map((b, i) => (
                <Fragment key={`${b.scope}:${b.field}`}>
                  {i > 0 && ', '}
                  <strong>{b.value}</strong> in {b.field} ({b.scope})
                </Fragment>
              ))}
              , which its tagset does not allow. Applying it would put that value on every ticked
              occurrence at once, so pick a different analysis or fix this one in its document
              first.
            </p>
          )}
          {target && (
            <ApplyBar
              count={targetBad.length ? 0 : selectedRows.length}
              busy={r.busy}
              onApply={doApply}
              summary={`${plural(selectedRows.length, 'occurrence')} of “${plan.form}” will be re-analyzed as ${label(target.analysis)}, replacing their current analyses.`}
            >
              <SelectionSummary
                rows={plan.rows.filter((x) => x.signature !== targetSig)}
                selected={r.selected}
                setSelected={r.setSelected}
                extra={
                  <>
                    {' '}
                    ({plural(target.count, 'occurrence')} {target.count === 1 ? 'has' : 'have'}{' '}
                    {targetName})
                  </>
                }
              />
            </ApplyBar>
          )}
          {plan.rows.length > 0 && (
            <MatchGroups
              projectId={projectId}
              rows={plan.rows}
              selected={r.selected}
              toggle={r.toggle}
              toggleMany={r.toggleMany}
              dim={(row) => row.signature === targetSig}
              renderRow={(row) =>
                row.signature === targetSig ? (
                  <span className="text-xs text-muted-foreground">has {targetName}</span>
                ) : (
                  <div className="min-w-0 max-w-full overflow-x-auto">
                    <AnalysisCard
                      word={plan.form}
                      analysis={row.analysis}
                      rows={cardRows}
                      itemFormById={plan.itemFormById}
                      labels={false}
                    />
                  </div>
                )
              }
            />
          )}
        </>
      )}
    </div>
  );
};

// ---- merge ----------------------------------------------------------------------
