import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Label } from '@ui/components/ui/label';
import { Button } from '@ui/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from '@ui/components/ui/select';
import { notifySuccess, notifyWarning } from '@/utils/feedback';
import {
  isValueAllowed,
  readingTagset,
  readTagsetName,
  resolveTagset,
  tagsetEnforces,
} from '@/domain/tagsets';
import { MATCH_TYPES, searchDomains } from '../search/searchQueries.js';
import { blank, buildReplacer } from './bulkPlan.js';
import { planField, applyField } from './bulkRunner.js';
import { notifyStopped, skippedNote, useRun, useWriter } from './bulkShared.js';
import { t, tx } from '@ui/lib/i18n.js';
import { scopeTextClass } from '@/domain/scopeColors';
import {
  ApplyBar,
  ChangeGrid,
  MatchGroups,
  Progress,
  SelectionSummary,
  SubstitutionFields,
} from './parts.jsx';
import { usePreviewFocus } from './usePreviewFocus.js';
import { fieldApplyLabel } from '@/domain/editLabels.js';

// Field replace: find and replace inside one annotation field.
// The tagset governing a replace target, or null. Only annotation fields have
// one: a morpheme form is a form, not an annotation. A bulk replace is a write
// like any other, so an enforcing tagset has to bite here too — otherwise the
// rule is bypassable from inside the app that enforces it.
const tagsetForTarget = (target, layerInfo, project) => {
  if (!target || target.kind !== 'span') return null;
  const layer = (layerInfo?.spanLayers?.[target.scope] || []).find((l) => l.id === target.layerId);
  if (!layer) return null;
  const ts = resolveTagset(layer.config, project?.config);
  // The name rides along so the warning can say which list refused the values.
  return ts ? { ...ts, name: readTagsetName(layer.config) } : null;
};

// "3 values replaced and 2 cleared in Gloss", or with `will`, "… will be
// replaced …". A clear is a row whose replacement leaves nothing. `field` is
// the field's name as shown.
const changeText = (replaced, cleared, field, will = false) => {
  if (replaced && cleared)
    return will
      ? t(
          '{replaced, plural, one {# value} other {# values}} will be replaced and {cleared} will be cleared in {field}',
          { replaced, cleared, field },
        )
      : t(
          '{replaced, plural, one {# value} other {# values}} replaced and {cleared} cleared in {field}',
          { replaced, cleared, field },
        );
  if (cleared)
    return will
      ? t('{n, plural, one {# value} other {# values}} will be cleared in {field}', {
          n: cleared,
          field,
        })
      : t('{n, plural, one {# value} other {# values}} cleared in {field}', { n: cleared, field });
  return will
    ? t('{n, plural, one {# value} other {# values}} will be replaced in {field}', {
        n: replaced,
        field,
      })
    : t('{n, plural, one {# value} other {# values}} replaced in {field}', { n: replaced, field });
};

// One field match: the word (and morpheme) it sits under as context, then the
// field's before → after.
const FieldChange = ({ row, target }) => {
  const lines = [];
  if (row.word != null)
    lines.push({ label: t('Word'), cls: scopeTextClass('word'), from: row.word });
  if (row.morpheme != null)
    lines.push({ label: t('Morpheme'), cls: scopeTextClass('morpheme'), from: row.morpheme });
  const scope = target.kind === 'morpheme' ? 'morpheme' : target.scope;
  lines.push({
    label: target.kind === 'morpheme' ? t('Morpheme form') : target.field,
    cls: scopeTextClass(scope),
    from: row.old,
    to: row.new,
  });
  return (
    <>
      <ChangeGrid lines={lines} />
      {row.invalid === 'tagset' && (
        <p className="mt-1 text-xs text-destructive">
          {t('Outside the tagset, so it will be skipped.')}
        </p>
      )}
      {row.invalid === 'empty' && (
        <p className="mt-1 text-xs text-destructive">{t('Empty form, so it will be skipped.')}</p>
      )}
      {row.invalid === 'formless' && (
        <p className="mt-1 text-xs text-destructive">
          {t('Spelled as its word, so it will be skipped. Respell the word to change it.')}
        </p>
      )}
      {!row.invalid && row.kind === 'span' && blank(row.new) && (
        <p className="mt-1 text-xs text-muted-foreground">{t('Clears the value.')}</p>
      )}
    </>
  );
};

export const FieldPanel = ({ project, projectId, client, layerInfo }) => {
  const writer = useWriter(project);
  const targets = useMemo(
    () => searchDomains(layerInfo, []).filter((d) => d.kind === 'span' || d.kind === 'morpheme'),
    [layerInfo],
  );
  // A link from Validation fills the form in: `in` the field, `q` what to
  // find, `match` how, `repl` the replacement.
  const [params] = useSearchParams();
  const [targetId, setTargetId] = useState(() => {
    const asked = params.get('in');
    return targets.some((d) => d.id === asked) ? asked : (targets[0]?.id ?? '');
  });
  const [find, setFind] = useState(() => params.get('q') || '');
  const [matchType, setMatchType] = useState(() => {
    const asked = params.get('match');
    return MATCH_TYPES.some((m) => m.id === asked) ? asked : 'contains';
  });
  const [repl, setRepl] = useState(() => params.get('repl') || '');
  const r = useRun();
  const target = targets.find((d) => d.id === targetId) ?? targets[0];
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
      ...(fields.length ? [{ label: t('Annotations'), items: fields }] : []),
      ...(morph.length
        ? [{ label: t('Forms'), items: morph.map((d) => ({ ...d, label: t('Morpheme form') })) }]
        : []),
    ];
  }, [targets]);

  const results = usePreviewFocus([find, matchType, repl, targetId].join('\u0000'));
  const preview = async () => {
    if (!find || error || !target) return;
    results.begin();
    const plan = await r.run(
      'Preview',
      (onProgress) => planField(client, project, target, { find, matchType, apply }, onProgress),
      { reset: true },
    );
    if (!plan) return;
    // An enforcing tagset refuses the values this replace would produce. Flag
    // rows and leave them unticked rather than blocking the whole preview: the
    // rest of the replace is usually fine, and seeing WHICH values are refused
    // is how you decide whether to fix the replacement or the tagset. A value
    // the replacement empties is cleared, which no tagset refuses.
    const rows = tagsetEnforces(tagset)
      ? plan.rows.map((x) =>
          x.invalid || blank(x.new) || isValueAllowed(x.new, readingTagset(tagset, x.reading))
            ? x
            : { ...x, invalid: 'tagset' },
        )
      : plan.rows;
    r.setPlan({ ...plan, rows, find, repl, target, tagset });
    results.shown();
    r.setSelected(new Set(rows.filter((x) => !x.invalid).map((x) => x.id)));
  };

  const plan = r.plan;
  // What an Apply sends: the selected rows a stopped Apply has not already
  // sent or skipped (`applied`), so the count and the confirm say what is left.
  const selectedRows = plan ? plan.rows.filter((x) => r.selected.has(x.id) && !x.applied) : [];
  const morphemeTarget = plan?.target?.kind === 'morpheme';
  // The audit label's name for the field, which is stored and stays English.
  const targetLabel = morphemeTarget ? 'morpheme form' : plan?.target?.field; // i18n-ignore: an audit label, stored on the server
  // The same field as the person reads it.
  const targetShown = morphemeTarget ? t('morpheme form') : plan?.target?.field;
  const writableRows = selectedRows.filter((x) => !x.invalid);
  const clearing = writableRows.filter((x) => x.kind === 'span' && blank(x.new)).length;
  const willChange = changeText(writableRows.length - clearing, clearing, targetShown, true);

  const doApply = async () => {
    // Ticking a flagged row by hand does not make it writable: the same rule
    // that stops it being typed stops it being bulk-written.
    const writable = selectedRows.filter((x) => !x.invalid);
    const res = await r.run('Apply', (onProgress) =>
      applyField(
        client,
        { rows: writable, versions: plan.versions, replan: plan.replan },
        {
          writer,
          label: fieldApplyLabel(plan.find, blank(plan.repl) ? '' : plan.repl, targetLabel),
          onProgress,
        },
      ),
    );
    if (!res) return;
    const skipped = skippedNote([[res.skipped, 'value']]);
    if (res.failed) {
      // The plan stays, so Apply again sends what did not land.
      notifyStopped(
        res.failed,
        changeText(res.changed - (res.cleared ?? 0), res.cleared ?? 0, targetShown),
        skipped,
      );
      return;
    }
    if (!res.changed && skipped) notifyWarning(skipped.trim(), t('Nothing replaced'));
    else
      notifySuccess(
        `${changeText(res.changed - (res.cleared ?? 0), res.cleared ?? 0, targetShown)}.${skipped}`,
        res.cleared && res.cleared === res.changed ? t('Cleared') : t('Replaced'),
      );
    r.setPlan(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-1">
          <Label>{t('In')}</Label>
          <Select value={target?.id ?? ''} onValueChange={setTargetId}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder={t('Choose a field')} />
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
        {error && (
          <p className="text-sm text-destructive">{t('Check your regex: {error}', { error })}</p>
        )}
        {/* The lexicon's Replace has a fourth match, "is empty", and this one
            does not: a field has no value on a word until something writes
            one, so filling every blank means visiting every word rather than
            matching what is there. Said here because this is where people
            look for it first. No screen lists the blank cells, so the line
            names none (H6-1). */}
        <p className="text-xs text-muted-foreground">
          {t('Replaces values that are already there.')}
        </p>
        <div className="flex items-center">
          <Button
            className="ml-auto"
            onClick={preview}
            disabled={r.busy || !find || !!error || !target}
          >
            {r.busy && !plan ? t('Searching…') : t('Preview')}
          </Button>
        </div>
      </div>
      <Progress text={r.progress} startedAt={r.startedAt} />
      {plan && (
        <>
          <ApplyBar
            focusRef={results.ref}
            count={selectedRows.filter((x) => !x.invalid).length}
            busy={r.busy}
            onApply={doApply}
            summary={`${willChange}.`}
          >
            <SelectionSummary
              rows={plan.rows}
              selected={r.selected}
              setSelected={r.setSelected}
              selectable={(x) => !x.invalid}
            />
          </ApplyBar>
          {plan.rows.some((x) => x.invalid === 'tagset') && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {plan.tagset?.name
                ? tx(
                    '{n, plural, one {# value} other {# values}} would fall outside the <strong>{name}</strong> tagset and cannot be written. Those rows are marked and will be skipped.',
                    {
                      n: plan.rows.filter((x) => x.invalid === 'tagset').length,
                      name: plan.tagset.name,
                      strong: (c) => <strong>{c}</strong>,
                    },
                  )
                : tx(
                    '{n, plural, one {# value} other {# values}} would fall outside the <strong>field</strong> tagset and cannot be written. Those rows are marked and will be skipped.',
                    {
                      n: plan.rows.filter((x) => x.invalid === 'tagset').length,
                      strong: (c) => <strong>{c}</strong>,
                    },
                  )}
            </p>
          )}
          {plan.rows.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('No matching values.')}
            </p>
          )}
          <MatchGroups
            selectable={(x) => !x.invalid}
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
