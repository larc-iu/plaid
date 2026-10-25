import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { cn } from '@ui/lib/utils';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { ValidationHeader } from '@ui/components/shared/ValidationHeader.jsx';
import { notifyError, notifyInfo, notifySuccess, humanizeError } from '@/utils/feedback';
import { expectStored, isConfigConflict, withStoredConfig } from '@ui/domain/configCells.js';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import { governedFields, offTagsetValues, readTagsetName, readTagsets } from '@/domain/tagsets';
import { fieldsOutOfForce, igtFields, queueFieldDeclarations } from '@/domain/igtConstraints';
import { putRulesInForce } from '../settings/putRulesInForce.js';
import { ZERO_MORPH, looksLikeZeroMorph } from '@/domain/zeroMorph';
import { freqQueries, metadataHitsQuery, searchDomains } from '../search/searchQueries.js';
import { runHitsSearch } from '../search/searchRunner.js';
import { listedCount, locateFailing } from './locateFailing.js';
import { findDoubles } from '@/domain/doubles';
import { distinctValues, loadAttested } from './attested.js';
import { MarkedText } from '@ui/components/shared/MarkedText.jsx';
import { hitTo, rememberCaret } from '../search/hitLinks.js';
import { scopeBadgeClass } from '@/domain/scopeColors';
import { countOf, plural } from '@ui/lib/plural.js';

// Values in the project that its own tagsets say are wrong.
//
// A closed list is a rule core holds (a value set on each field it governs,
// tagsets.js), so every writer is refused an off-list value. Core lets through
// an unverified machine value and an import's, and an open list holds anything:
// this is where you find out what got in.
//
// Finding them costs one aggregate query per governed field. The server returns
// the field's whole value inventory ([value, count]) and the diff against the
// tagset happens here, so nothing loads a document until you click into a
// specific value and ask where it is.

// Every span in a layer regardless of value: the REGEXP UDF matches on
// contains, so "." means "has at least one character".
const ANY_VALUE = { regex: '.' };

// Documents whose metadata field holds this value, shaped like a hit search so
// one renderer handles both.
const locateMetadata = async (client, projectId, field, value) => {
  const res = await client.query(metadataHitsQuery(projectId, field, value));
  return {
    groups: (res?.results || []).map(([docId, docName]) => ({
      docId: String(docId),
      docName: docName || '(untitled)',
      docHits: 1,
      rows: [],
    })),
    remainingDocs: 0,
    remainingHits: 0,
  };
};

// Bulk Edit's field replace, filled in for one row: the field (or the morpheme
// form), the value matched whole, and a replacement when the row has one.
// Only a field or a morpheme form can be replaced there.
const bulkFixHref = (projectId, domain, value, replacement = '') => {
  const p = new URLSearchParams({ tab: 'bulk', op: 'field' });
  if (domain?.kind === 'span' || domain?.kind === 'morpheme') {
    p.set('in', domain.id);
    p.set('q', value);
    p.set('match', 'exact');
    if (replacement) p.set('repl', replacement);
  }
  return `/projects/${projectId}?${p}`;
};

const MODE_LABELS = { suggest: 'open', closed: 'closed', mixed: 'closed, plus lexical glosses' };

const reasonText = (violations) => {
  const unknown = violations.filter((v) => v.reason === 'unknown').map((v) => v.part);
  if (unknown.length) return `${unknown.map((u) => `"${u}"`).join(', ')} not in the tagset`;
  return 'a delimiter with nothing beside it';
};

// The occurrences panel for one flagged value, shared by both checks below.
const Occurrences = ({ res, projectId }) => (
  <div className="border-t bg-muted/20 px-3 py-2">
    {!res && <p className="text-sm text-muted-foreground">Finding occurrences…</p>}
    {res?.failed && (
      <p className="text-sm text-destructive">Failed to search for this value. Try again.</p>
    )}
    {res && !res.failed && res.groups.length === 0 && (
      <p className="text-sm text-muted-foreground">
        {res.passed > 0
          ? 'Every occurrence found is in the tagset as read in its word.'
          : 'No occurrences found. The value may have been changed since the last check.'}
      </p>
    )}
    {res &&
      !res.failed &&
      res.groups.map((grp) => (
        <div key={grp.docId} className="mb-3 last:mb-0">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            {grp.rows.length ? (
              grp.docName
            ) : (
              // Metadata is the document's default tab, and
              // a tab link writes the bare path for a default.
              <Link
                to={`/projects/${projectId}/documents/${grp.docId}`}
                className="text-foreground hover:underline"
              >
                {grp.docName}
              </Link>
            )}
            {grp.rows.length > 0 && (
              <span className="font-normal text-muted-foreground">({grp.docHits})</span>
            )}
          </p>
          {grp.rows.map((r) => (
            <Link
              key={r.sentenceId}
              to={hitTo(projectId, grp.docId, r.sentenceId)}
              onClick={() => rememberCaret(grp.docId, r.sentenceId, r.hitBegin)}
              className={cn(
                'block rounded-sm px-2 py-1 text-sm hover:bg-background',
                'text-foreground no-underline',
              )}
            >
              <span className="mr-2 text-xs text-muted-foreground">{r.sentenceIndex + 1}</span>
              <MarkedText text={r.text} marks={r.marks} />
              {r.translation && (
                <span className="ml-2 text-xs italic text-muted-foreground">{r.translation}</span>
              )}
            </Link>
          ))}
          {grp.capped && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              More in this document not shown.
            </p>
          )}
        </div>
      ))}
    {res && !res.failed && res.remainingDocs > 0 && (
      <p className="text-xs text-muted-foreground">
        {res.remainingHits == null
          ? `${res.remainingDocs.toLocaleString()} more ${plural(res.remainingDocs, 'document')} with this value not shown.`
          : `${res.remainingHits.toLocaleString()} more in ${countOf(res.remainingDocs, 'document')} not shown.`}
      </p>
    )}
  </div>
);

export const ProjectValidation = ({ project, projectId, client, onProjectUpdate }) => {
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const domains = useMemo(() => searchDomains(layerInfo, []), [layerInfo]);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState(null);
  const [expanded, setExpanded] = useState(null); // `${layerId}:${value}`
  const [hits, setHits] = useState({});
  // Which scan the opened rows belong to. A row opened before a re-check
  // lands nowhere once it answers.
  const scanRun = useRef(0);
  const [zeros, setZeros] = useState(null);
  // The fields whose group of word-like values (an open list's) is open.
  const [wordsOpen, setWordsOpen] = useState({});

  // Morpheme forms that look like a zero someone spelled another way. A
  // pseudo-field so it can share `locate` and the row markup below.
  const morphemes = useMemo(() => {
    const domain = domains.find((d) => d.kind === 'morpheme') ?? null;
    return domain ? { key: 'zero-morph', kind: 'morpheme', domain } : null;
  }, [domains]);

  // The fields under a tagset, from the one place that answers that, plus the
  // search domain a span field's hit lookup needs.
  const governed = useMemo(
    () =>
      governedFields(layerInfo, project?.config).map((g) => ({
        ...g,
        domain:
          g.kind === 'span'
            ? domains.find((d) => d.kind === 'span' && d.layerId === g.layerId)
            : null,
      })),
    [layerInfo, project?.config, domains],
  );

  // The fields whose rules on the server are not what their settings say: a
  // closed list an import or a save left out of force, a list no closed
  // tagset names any more, a field a script made without its rules.
  const outOfForce = useMemo(() => fieldsOutOfForce(project), [project]);
  const [forcing, setForcing] = useState(false);
  // Of each field without one annotation a unit, the units holding more
  // than one, by layer id: `{count, rows}`, or `{failed: true}`.
  const [doubles, setDoubles] = useState({});
  useEffect(() => {
    const singles = outOfForce.filter((f) => f.single);
    if (!singles.length || !client) {
      setDoubles({});
      return undefined;
    }
    let live = true;
    Promise.all(
      singles.map(async (f) => {
        try {
          return [f.layerId, await findDoubles(client, f.layerId)];
        } catch (err) {
          console.error('Could not find the doubled annotations:', err);
          return [f.layerId, { failed: true }];
        }
      }),
    ).then((entries) => {
      if (live) setDoubles(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [client, outOfForce, projectId]);
  // Put the rules of `targets` (entries of `outOfForce`) in force, and say
  // what changed: `done` names it when nothing was left out. With `listOnly`
  // (Remove the list), what the heal left is read back and said field by
  // field: a list another maintainer's change made wanted again since this
  // screen read the project stays. What else stays out is on the screen
  // already.
  const putInForce = async (targets, done, { listOnly = false } = {}) => {
    setForcing(true);
    try {
      const ids = new Set(targets.map((f) => f.layerId));
      const notInForce = await putRulesInForce(client, projectId, {
        layers: (id) => ids.has(id),
        here: true,
        quiet: listOnly,
      });
      if (notInForce && listOnly) {
        await sayListsRemoved(targets);
      } else if (notInForce && !notInForce.length) {
        notifySuccess(done);
      }
      await onProjectUpdate?.();
    } finally {
      setForcing(false);
    }
  };

  // After Remove the list: which of `targets` hold no list now, and which
  // kept theirs (their tagset closed again since, or another change).
  const sayListsRemoved = async (targets) => {
    let fresh;
    try {
      fresh = await client.projects.get(projectId);
    } catch (err) {
      console.error('Could not read the project after removing the list:', err);
      return;
    }
    const layers = new Map(igtFields(getIgtLayerInfo(fresh)).map((sl) => [sl.id, sl]));
    const stillStale = new Set(
      fieldsOutOfForce(fresh)
        .filter((f) => f.stale)
        .map((f) => f.layerId),
    );
    const holdsList = (f) =>
      (layers.get(f.layerId)?.constraints?.[IGT_NAMESPACE] || []).some(
        (c) => c.type === 'value-set',
      );
    const removed = targets.filter((f) => !holdsList(f));
    if (removed.length) {
      notifySuccess(`The list on ${removed.map((f) => f.field).join(', ')} is removed`);
    }
    for (const f of targets.filter(holdsList)) {
      const tagset = readTagsetName(layers.get(f.layerId)?.config);
      notifyInfo(
        !stillStale.has(f.layerId) && tagset
          ? `The list on ${f.field} stays: ${tagset} is closed.`
          : `The list on ${f.field} stays.`,
      );
    }
  };

  const scan = useCallback(async () => {
    setBusy(true);
    // What an opened row found belongs to the scan before, and its count
    // would stand in for the new scan's.
    scanRun.current += 1;
    setHits({});
    setExpanded(null);
    try {
      const rows = await Promise.all(
        (governed || []).map(async (g) => {
          const attested = await loadAttested(client, projectId, g);
          return { ...g, attested, bad: offTagsetValues(attested, g.tagset) };
        }),
      );
      setFields(rows);
      // Same two-phase trick as the tagset scan: one aggregate query brings
      // back every morpheme form in the project with its count, and the
      // comparison happens here. No document loads until a row is opened.
      if (!morphemes) {
        setZeros([]);
        return;
      }
      const res = await Promise.all(
        freqQueries(morphemes.domain, ANY_VALUE).map((q) => client.query(q)),
      );
      setZeros(
        res
          .flatMap((r) => r?.results || [])
          .filter(([v]) => typeof v === 'string' && looksLikeZeroMorph(v))
          .map(([value, n]) => ({ value, count: n || 0 })),
      );
    } catch (err) {
      console.error('Validation scan failed:', err);
      notifyError(humanizeError(err), 'Failed to check the values');
      setFields([]);
      setZeros([]);
    } finally {
      setBusy(false);
    }
  }, [client, governed, morphemes, projectId]);

  useEffect(() => {
    scan();
  }, [scan]);

  // Where a value actually is. Only run when a row is opened: this is the part
  // that loads documents.
  const locate = async (g, value) => {
    const key = `${g.key}:${value}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (hits[key]) return;
    const run = scanRun.current;
    const record = (res) => {
      if (scanRun.current === run) setHits((h) => ({ ...h, [key]: res }));
    };
    try {
      // A metadata violation is a property of a whole document, so there is no
      // sentence to show in context: the answer is which documents hold it.
      // A span field lists only the occurrences that fail where they sit, as
      // the scan counted only the failing ones. The zero-morph pseudo-field has
      // no tagset, so every occurrence of its form is listed.
      const res =
        g.kind === 'metadata'
          ? await locateMetadata(client, projectId, g.field, value)
          : g.kind === 'span'
            ? await locateFailing(client, project, layerInfo, g, value)
            : await runHitsSearch(client, project, layerInfo, g.domain, value, 'exact');
      record(res);
    } catch (err) {
      console.error('Could not locate value:', err);
      notifyError(humanizeError(err), 'Failed to find these values');
      // Record the failure. Leaving the entry unset would sit on "Finding
      // occurrences…" forever, which reads as a hang once the toast is gone.
      record({ failed: true, groups: [] });
    }
  };

  // Add an unknown part to the tagset. The other remedy (change the values) is
  // a bulk replace, which is why every row also links there.
  // The parts are added to the tagsets as stored, read when the button is
  // pressed, so a field another maintainer pointed at the tagset since this
  // page was read takes the list too. A write refused because someone saved
  // the tagsets in between is made again to what they saved.
  const addToTagset = async (g, parts) => {
    const attempt = async (p) => {
      // The field as stored now: one moved to another tagset since this page
      // was read takes nothing, rather than the list it no longer uses.
      const now = governedFields(getIgtLayerInfo(p), p?.config).find((x) => x.key === g.key);
      if ((now?.tagsetName ?? null) !== g.tagsetName) {
        throw Object.assign(new Error('Field moved'), { movedTo: now?.tagsetName ?? null });
      }
      const tagsets = readTagsets(p?.config);
      const t = tagsets[g.tagsetName];
      if (!t) throw new Error(`Tagset "${g.tagsetName}" no longer exists`);
      const have = new Set(t.values.map((v) => v.value));
      const fresh = parts.filter((v) => v && !have.has(v)).map((value) => ({ value }));
      if (!fresh.length) return fresh;
      const next = { ...tagsets, [g.tagsetName]: { ...t, values: [...t.values, ...fresh] } };
      // A closed tagset's list is a rule its fields hold on the server, so
      // the fields it governs take the new list in the same batch.
      await client.batched((b) => {
        b.projects.setConfig(
          projectId,
          IGT_NAMESPACE,
          'tagsets',
          next,
          undefined,
          expectStored(p, IGT_NAMESPACE, 'tagsets'),
        );
        queueFieldDeclarations(
          b,
          igtFields(getIgtLayerInfo(p)),
          withStoredConfig(p, IGT_NAMESPACE, 'tagsets', next).config,
          p?.config,
        );
      });
      return fresh;
    };
    try {
      let fresh;
      try {
        fresh = await attempt(await client.projects.get(projectId));
      } catch (err) {
        if (!isConfigConflict(err)) throw err;
        fresh = await attempt(await client.projects.get(projectId));
      }
      if (!fresh.length) return;
      notifySuccess(`${fresh.map((f) => `“${f.value}”`).join(', ')} added to ${g.tagsetName}`);
      await putRulesInForce(client, projectId, { here: true });
      // The scan reads the tagset from the project, so refresh it and re-check.
      await onProjectUpdate?.();
    } catch (err) {
      if (err?.movedTo !== undefined) {
        notifyError(
          err.movedTo
            ? `${g.field} uses “${err.movedTo}” now. Nothing was added.`
            : `${g.field} has no tagset now. Nothing was added.`,
          'Failed to update the tagset',
        );
        await onProjectUpdate?.();
        return;
      }
      console.error('Could not add to tagset:', err);
      notifyError(humanizeError(err), 'Failed to update the tagset');
    }
  };

  const header = (
    <ValidationHeader
      description="Checks every value in the project against its field's tagset, and looks for zero morphs written the wrong way. Values from imports and services are not held to closed lists."
      busy={busy}
      onCheck={scan}
      className="mb-0"
    />
  );

  if (fields === null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Loading label="Checking values…" className="p-0" />
      </div>
    );
  }

  // One flagged value's row. `addable` offers Add to tagset, which a word-like
  // value on an open list does not get.
  const renderRow = (g, row, addable) => {
    const key = `${g.key}:${row.value}`;
    const open = expanded === key;
    const res = hits[key];
    const unknownParts = row.violations.filter((v) => v.reason === 'unknown').map((v) => v.part);
    // The scan's count reads each morpheme alone. Once the row is open
    // and lists every failing occurrence, their number replaces it.
    const count = listedCount(res) ?? row.count;
    return (
      <div key={row.value} className="border-b last:border-b-0">
        <div className="flex items-center gap-3 px-3 py-2">
          {g.domain || g.kind === 'metadata' ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              onClick={() => locate(g, row.value)}
              title={open ? 'Hide occurrences' : 'Show occurrences'}
            >
              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          ) : (
            // No searchable domain for this layer, so there is nothing
            // to expand. Hold the column rather than offering a control
            // that would open an empty panel.
            <span className="h-6 w-6 shrink-0" />
          )}
          <code
            className={`rounded px-1.5 py-0.5 text-sm ${
              row.flagged ? 'bg-destructive/10 text-destructive' : 'bg-muted'
            }`}
          >
            {row.value}
          </code>
          <span className="text-xs text-muted-foreground">
            {countOf(count, 'occurrence')} · {reasonText(row.violations)}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {addable && unknownParts.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => addToTagset(g, unknownParts)}
                title={`Add ${unknownParts.join(', ')} to ${g.tagsetName}`}
              >
                <Plus className="h-3.5 w-3.5" /> Add to tagset
              </Button>
            )}
            <Button size="sm" variant="ghost" asChild>
              <Link to={bulkFixHref(projectId, g.domain, row.value)}>Fix in Bulk Edit</Link>
            </Button>
          </div>
        </div>

        {open && <Occurrences res={res} projectId={projectId} />}
      </div>
    );
  };

  const totalBad = fields.reduce((a, f) => a + f.bad.length, 0);
  const zeroRows = zeros || [];
  // Fields to put in force: a closed list not held, one annotation a unit
  // not held, or any other difference. Fields holding a list no closed
  // tagset names: the list to remove, and one annotation a unit with the
  // rest when that is out too.
  const stale = outOfForce.filter((f) => f.stale);
  const toForce = outOfForce.filter((f) => !f.stale || f.single);
  const unitOf = (f) =>
    ({ Word: 'word', Morpheme: 'morpheme', Sentence: 'sentence' })[f.scope] ?? 'word';
  // Each field once, with every rule of it not in force.
  const forceText = `Not in force: ${toForce
    .map((f) => {
      if (f.list && f.single) return `${f.tagset} and one annotation a ${unitOf(f)} on ${f.field}`;
      if (f.list) return `${f.tagset} on ${f.field}`;
      if (f.single) return `one annotation a ${unitOf(f)} on ${f.field}`;
      return `the rules of ${f.field}`;
    })
    .join(', ')}.`;
  const doubled = outOfForce.filter((f) => f.single && doubles[f.layerId]?.count > 0);
  const listNames = (fs) => fs.map((f) => f.field).join(', ');

  return (
    <div className="flex flex-col gap-4">
      {header}

      {outOfForce.length > 0 && (
        <Notice tone="warning" icon={AlertTriangle} data-testid="rules-out-of-force">
          <div className="flex flex-col gap-1">
            {toForce.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{forceText}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={forcing}
                  onClick={() => putInForce(toForce, `In force on ${listNames(toForce)}`)}
                >
                  Put in force
                </Button>
              </div>
            )}
            {doubled.map((f) => {
              const { count, rows } = doubles[f.layerId];
              return (
                <div key={f.layerId} data-testid="doubled-units" className="mt-1">
                  <p>{`${f.field}: ${countOf(count, unitOf(f))} with more than one annotation`}</p>
                  <ul className="mt-1 flex flex-col">
                    {rows.map((r, i) => (
                      <li key={`${r.docId}:${r.begin}:${i}`}>
                        <Link
                          to={
                            r.sentenceId
                              ? hitTo(projectId, r.docId, r.sentenceId)
                              : `/projects/${projectId}/documents/${r.docId}?tab=analyze`
                          }
                          onClick={() =>
                            r.sentenceId && rememberCaret(r.docId, r.sentenceId, r.begin)
                          }
                          className="text-foreground hover:underline"
                        >
                          {`${r.docName} · ${r.form}`}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {r.values
                            .map((v) => (v == null || v === '' ? '(empty)' : String(v)))
                            .join(' | ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {count > rows.length && (
                    <p className="text-xs text-muted-foreground">{`${count - rows.length} more not shown.`}</p>
                  )}
                </div>
              );
            })}
            {stale.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{`In force with no closed tagset: the list on ${listNames(stale)}.`}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={forcing}
                  onClick={() => putInForce(stale, null, { listOnly: true })}
                >
                  Remove the list
                </Button>
              </div>
            )}
          </div>
        </Notice>
      )}

      {totalBad === 0 && governed.length > 0 && (
        <Notice tone="success" icon={Check} className="items-center px-4 py-3">
          Every value in {countOf(fields.length, 'governed field')} is in its tagset.
        </Notice>
      )}

      {governed.length === 0 && (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No field uses a tagset yet. Assign one under Settings → Annotation, and this tab will list
          any values outside it.
        </div>
      )}

      {zeroRows.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
            <Badge variant="secondary" className={scopeBadgeClass('morpheme')}>
              morpheme
            </Badge>
            <span className="font-medium">Form</span>
            <span className="text-xs text-muted-foreground">
              looks like a zero morph written another way
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              {countOf(zeroRows.length, 'form')} to check
            </span>
          </div>
          {zeroRows.map((row) => {
            const key = `${morphemes.key}:${row.value}`;
            const open = expanded === key;
            const res = hits[key];
            return (
              <div key={row.value} className="border-b last:border-b-0">
                <div className="flex items-center gap-3 px-3 py-2">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0"
                    onClick={() => locate(morphemes, row.value)}
                    title={open ? 'Hide occurrences' : 'Show occurrences'}
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                  <code className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-sm text-destructive">
                    {row.value}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {countOf(row.count, 'occurrence')} · did you mean{' '}
                    <code className="text-foreground">{ZERO_MORPH}</code>? Only {ZERO_MORPH} is read
                    as a zero on export.
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" asChild>
                      <Link to={bulkFixHref(projectId, morphemes.domain, row.value, ZERO_MORPH)}>
                        Fix in Bulk Edit
                      </Link>
                    </Button>
                  </div>
                </div>
                {open && <Occurrences res={res} projectId={projectId} />}
              </div>
            );
          })}
        </div>
      )}

      {fields.map((g) => (
        <div key={g.key} className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
            <Badge variant="secondary" className={scopeBadgeClass(g.scope)}>
              {g.scope}
            </Badge>
            <span className="font-medium">{g.field}</span>
            <span className="text-xs text-muted-foreground">
              {g.tagsetName} · {MODE_LABELS[g.tagset.mode]} ·{' '}
              {countOf(distinctValues(g.attested), 'distinct value')}
            </span>
            <FieldCount bad={g.bad} />
          </div>

          {g.bad.filter((row) => !row.lexical).map((row) => renderRow(g, row, true))}
          {g.bad.some((row) => row.lexical) && (
            <WordsGroup
              rows={g.bad.filter((row) => row.lexical)}
              open={!!wordsOpen[g.key]}
              onToggle={() => setWordsOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
            >
              {g.bad.filter((row) => row.lexical).map((row) => renderRow(g, row, false))}
            </WordsGroup>
          )}
        </div>
      ))}
    </div>
  );
};

// What a field's header says: red for the values its cells mark, grey for an
// open list's values a close would refuse, green when there are none.
const FieldCount = ({ bad }) => {
  const flagged = bad.filter((row) => row.flagged).length;
  const unlisted = bad.length - flagged;
  if (!bad.length)
    return (
      <span className="ml-auto flex items-center gap-1.5 text-sm text-success-foreground">
        <Check className="h-4 w-4" /> All in the tagset
      </span>
    );
  return (
    <span className="ml-auto flex items-center gap-3 text-sm">
      {flagged > 0 && (
        <span className="flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {flagged} outside the tagset
        </span>
      )}
      {unlisted > 0 && <span className="text-muted-foreground">{unlisted} not in the tagset</span>}
    </span>
  );
};

// An open list's values whose every unlisted part reads as a word, not a tag:
// collapsed, and with no Add to tagset on each, so a list of tags is not made
// a word list one click at a time.
const WordsGroup = ({ rows, open, onToggle, children }) => (
  <div className="border-b last:border-b-0">
    <button
      type="button"
      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/30"
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      {rows.length} not written in capitals
    </button>
    {open && <div className="border-t">{children}</div>}
  </div>
);
