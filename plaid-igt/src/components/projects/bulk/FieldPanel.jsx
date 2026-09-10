import { useMemo, useState } from 'react';
import { Replace } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@/components/ui/select';
import { notifySuccess } from '@/utils/feedback';
import { isValueAllowed, readTagsetName, resolveTagset, tagsetEnforces } from '@/domain/tagsets';
import { searchDomains } from '../search/searchQueries.js';
import { buildReplacer } from './bulkPlan.js';
import { planField, applyField } from './bulkRunner.js';
import { SCOPE_CLS, plural, useRun } from './bulkShared.js';
import {
  ApplyBar,
  ChangeGrid,
  MatchGroups,
  Progress,
  SelectionSummary,
  SubstitutionFields,
} from './parts.jsx';

// Field replace: find and replace inside one annotation field.
// The tagset governing a replace target, or null. Only annotation fields have
// one: a morpheme form is a form, not an annotation. A bulk replace is a write
// like any other, so an enforcing tagset has to bite here too — otherwise the
// rule is bypassable from inside the app that enforces it.
const tagsetForTarget = (target, layerInfo, project) => {
  if (!target || target.kind !== 'span') return null;
  const layer = (layerInfo?.spanLayers?.[target.scope] || []).find((l) => l.id === target.layerId);
  if (!layer) return null;
  const t = resolveTagset(layer.config, project?.config);
  // The name rides along so the warning can say which list refused the values.
  return t ? { ...t, name: readTagsetName(layer.config) } : null;
};

// One field match: the word (and morpheme) it sits under as context, then the
// field's before → after.
export const FieldChange = ({ row, target }) => {
  const lines = [];
  if (row.word != null) lines.push({ label: 'Word', cls: SCOPE_CLS.word, from: row.word });
  if (row.morpheme != null)
    lines.push({ label: 'Morpheme', cls: SCOPE_CLS.morpheme, from: row.morpheme });
  const scope = target.kind === 'morpheme' ? 'morpheme' : target.scope;
  lines.push({
    label: target.kind === 'morpheme' ? 'Morpheme form' : target.field,
    cls: SCOPE_CLS[scope],
    from: row.old,
    to: row.new,
  });
  return (
    <>
      <ChangeGrid lines={lines} />
      {row.invalid && (
        <p className="mt-1 text-xs text-destructive">Outside the tagset, so it will be skipped.</p>
      )}
    </>
  );
};

export const FieldPanel = ({ project, projectId, client, layerInfo }) => {
  const targets = useMemo(
    () => searchDomains(layerInfo, []).filter((d) => d.kind === 'span' || d.kind === 'morpheme'),
    [layerInfo],
  );
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [find, setFind] = useState('');
  const [matchType, setMatchType] = useState('contains');
  const [repl, setRepl] = useState('');
  const r = useRun();
  const target = targets.find((t) => t.id === targetId) ?? targets[0];
  const tagset = useMemo(
    () => tagsetForTarget(target, layerInfo, project),
    [target, layerInfo, project],
  );
  const { apply, error } = useMemo(
    () => buildReplacer(find, matchType, repl),
    [find, matchType, repl],
  );

  const grouped = useMemo(() => {
    const fields = targets.filter((d) => d.kind === 'span');
    const morph = targets.filter((d) => d.kind === 'morpheme');
    return [
      ...(fields.length ? [{ label: 'Annotations', items: fields }] : []),
      ...(morph.length
        ? [{ label: 'Forms', items: morph.map((d) => ({ ...d, label: 'Morpheme form' })) }]
        : []),
    ];
  }, [targets]);

  const preview = async () => {
    if (!find || error || !target) return;
    const plan = await r.run(
      'Preview',
      (onProgress) => planField(client, project, target, { find, matchType, apply }, onProgress),
      { reset: true },
    );
    if (!plan) return;
    // An enforcing tagset refuses the values this replace would produce. Flag
    // rows and leave them unticked rather than blocking the whole preview: the
    // rest of the replace is usually fine, and seeing WHICH values are refused
    // is how you decide whether to fix the replacement or the tagset.
    const rows = tagsetEnforces(tagset)
      ? plan.rows.map((x) => (isValueAllowed(x.new, tagset) ? x : { ...x, invalid: true }))
      : plan.rows;
    r.setPlan({ ...plan, rows, find, repl, target, tagset });
    r.setSelected(new Set(rows.filter((x) => !x.invalid).map((x) => x.id)));
  };

  const plan = r.plan;
  const selectedRows = plan ? plan.rows.filter((x) => r.selected.has(x.id)) : [];
  const targetLabel = plan?.target?.kind === 'morpheme' ? 'morpheme form' : plan?.target?.field;

  const doApply = async () => {
    // Ticking a flagged row by hand does not make it writable: the same rule
    // that stops it being typed stops it being bulk-written.
    const writable = selectedRows.filter((x) => !x.invalid);
    const res = await r.run('Apply', () =>
      applyField(
        client,
        { rows: writable },
        { label: `Replace “${plan.find}” → “${plan.repl}” in ${targetLabel}` },
      ),
    );
    if (!res) return;
    notifySuccess(`${plural(res.changed, 'value')} replaced in ${targetLabel}.`, 'Replaced');
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <Label>In</Label>
          <Select value={target?.id ?? ''} onValueChange={setTargetId}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="Choose a field" />
            </SelectTrigger>
            <SelectContent>
              {grouped.map((g) => (
                <SelectGroup key={g.label}>
                  <SelectLabel>{g.label}</SelectLabel>
                  {g.items.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SubstitutionFields
          {...{ find, setFind, matchType, setMatchType, repl, setRepl }}
          onEnter={preview}
        />
        {error && <p className="text-sm text-destructive">Check your regex: {error}</p>}
        <div className="flex items-center">
          <Button
            className="ml-auto"
            onClick={preview}
            disabled={r.busy || !find || !!error || !target}
          >
            {r.busy && !plan ? 'Searching…' : 'Preview'}
          </Button>
        </div>
      </div>
      <Progress text={r.progress} />
      {plan && (
        <>
          <ApplyBar
            count={selectedRows.filter((x) => !x.invalid).length}
            busy={r.busy}
            onApply={doApply}
            summary={`${plural(selectedRows.filter((x) => !x.invalid).length, 'value')} in ${targetLabel} will be replaced.`}
          >
            <SelectionSummary rows={plan.rows} selected={r.selected} setSelected={r.setSelected} />
          </ApplyBar>
          {plan.rows.some((x) => x.invalid) && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {plural(plan.rows.filter((x) => x.invalid).length, 'value')} would fall outside the{' '}
              <strong>{plan.tagset?.name ?? 'field'}</strong> tagset and cannot be written. Those
              rows are marked and will be skipped.
            </p>
          )}
          {plan.rows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No matching values.</p>
          )}
          <MatchGroups
            projectId={projectId}
            rows={plan.rows}
            selected={r.selected}
            toggle={r.toggle}
            toggleMany={r.toggleMany}
            renderRow={(row) => <FieldChange row={row} target={plan.target} />}
          />
        </>
      )}
    </div>
  );
};

// ---- reanalyze -----------------------------------------------------------------
