import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { notifyError, notifySuccess, humanizeError } from '@/utils/feedback';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { IGT_NAMESPACE } from '@/domain/igtConfig';
import { governedFields, offTagsetValues, readTagsets } from '@/domain/tagsets';
import {
  freqQueries,
  metadataFreqQuery,
  metadataHitsQuery,
  searchDomains,
} from '../search/searchQueries.js';
import { runHitsSearch } from '../search/searchRunner.js';
import { MarkedText } from '../search/MarkedText.jsx';
import { hitTo, rememberCaret } from '../search/hitLinks.js';

// Values in the project that its own tagsets say are wrong.
//
// This view exists because "closed" is enforced in plaid-igt and nowhere else:
// typing is refused and a bulk replace is refused, but an import, a service,
// the assistant and a direct API call all reach the same span layer without
// passing either check. Rather than pretend the constraint is a database
// invariant, this is where you find out what got in.
//
// Finding them costs one aggregate query per governed field. The server returns
// the field's whole value inventory ([value, count]) and the diff against the
// tagset happens here, so nothing loads a document until you click into a
// specific value and ask where it is.

const SCOPE_CLS = {
  word: 'border-transparent bg-blue-100 text-blue-700',
  morpheme: 'border-transparent bg-teal-100 text-teal-700',
  sentence: 'border-transparent bg-green-100 text-green-700',
  document: 'border-transparent bg-amber-100 text-amber-700',
};

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

const MODE_LABELS = { suggest: 'open', closed: 'closed', mixed: 'closed + lexical' };

const reasonText = (violations) => {
  const unknown = violations.filter((v) => v.reason === 'unknown').map((v) => v.part);
  if (unknown.length) return `${unknown.map((u) => `"${u}"`).join(', ')} not in the tagset`;
  return 'a delimiter with nothing beside it';
};

export const ProjectValidation = ({ project, projectId, client, onProjectUpdate }) => {
  const layerInfo = useMemo(() => getIgtLayerInfo(project), [project]);
  const domains = useMemo(() => searchDomains(layerInfo, []), [layerInfo]);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState(null);
  const [expanded, setExpanded] = useState(null); // `${layerId}:${value}`
  const [hits, setHits] = useState({});

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

  const scan = useCallback(async () => {
    if (!governed.length) {
      setFields([]);
      return;
    }
    setBusy(true);
    try {
      const rows = await Promise.all(
        governed.map(async (g) => {
          const results = await Promise.all(
            g.kind === 'metadata'
              ? [client.query(metadataFreqQuery(projectId, g.field))]
              : freqQueries({ kind: 'span', layerId: g.layerId }, ANY_VALUE).map((q) =>
                  client.query(q),
                ),
          );
          const attested = [];
          for (const r of results) {
            for (const [value, n] of r?.results || []) {
              if (typeof value === 'string') attested.push([value, n || 0]);
            }
          }
          return { ...g, attested, bad: offTagsetValues(attested, g.tagset) };
        }),
      );
      setFields(rows);
    } catch (err) {
      console.error('Validation scan failed:', err);
      notifyError(humanizeError(err), 'Could not check values');
      setFields([]);
    } finally {
      setBusy(false);
    }
  }, [client, governed, projectId]);

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
    try {
      // A metadata violation is a property of a whole document, so there is no
      // sentence to show in context: the answer is which documents hold it.
      const res =
        g.kind === 'metadata'
          ? await locateMetadata(client, projectId, g.field, value)
          : await runHitsSearch(client, project, layerInfo, g.domain, value, 'exact');
      setHits((h) => ({ ...h, [key]: res }));
    } catch (err) {
      console.error('Could not locate value:', err);
      notifyError(humanizeError(err), 'Could not find these values');
      // Record the failure. Leaving the entry unset would sit on "Finding
      // occurrences…" forever, which reads as a hang once the toast is gone.
      setHits((h) => ({ ...h, [key]: { failed: true, groups: [] } }));
    }
  };

  // Add an unknown part to the tagset. The other remedy (change the values) is
  // a bulk replace, which is why every row also links there.
  const addToTagset = async (g, parts) => {
    try {
      const tagsets = readTagsets(project?.config);
      const t = tagsets[g.tagsetName];
      if (!t) throw new Error(`Tagset "${g.tagsetName}" no longer exists`);
      const have = new Set(t.values.map((v) => v.value));
      const fresh = parts.filter((p) => p && !have.has(p)).map((value) => ({ value }));
      if (!fresh.length) return;
      await client.projects.setConfig(projectId, IGT_NAMESPACE, 'tagsets', {
        ...tagsets,
        [g.tagsetName]: { ...t, values: [...t.values, ...fresh] },
      });
      notifySuccess(
        `${fresh.map((f) => `"${f.value}"`).join(', ')} added to ${g.tagsetName}`,
        'Tagset Updated',
      );
      // The scan reads the tagset from the project, so refresh it and re-check.
      await onProjectUpdate?.();
    } catch (err) {
      console.error('Could not add to tagset:', err);
      notifyError(humanizeError(err), 'Could not update the tagset');
    }
  };

  if (fields === null) {
    return <p className="py-6 text-sm text-muted-foreground">Checking values…</p>;
  }

  if (!governed.length) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        No field uses a tagset yet. Assign one under Settings → Annotation, and this tab will list
        any values outside it.
      </div>
    );
  }

  const totalBad = fields.reduce((a, f) => a + f.bad.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Checks every value in the project against its field's tagset. Closed lists apply to what
          you type and bulk edit, not to imports, services or the assistant, so their values show up
          here.
        </p>
        <Button variant="outline" className="ml-auto shrink-0" onClick={scan} disabled={busy}>
          {busy ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {totalBad === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-green-600/40 bg-green-50 px-4 py-3 text-sm text-green-800">
          <Check className="h-4 w-4 shrink-0" />
          Every value in {fields.length} governed field{fields.length === 1 ? '' : 's'} is in its
          tagset.
        </div>
      )}

      {fields.map((g) => (
        <div key={g.key} className="overflow-hidden rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
            <Badge variant="secondary" className={SCOPE_CLS[g.scope]}>
              {g.scope}
            </Badge>
            <span className="font-medium">{g.field}</span>
            <span className="text-xs text-muted-foreground">
              {g.tagsetName} · {MODE_LABELS[g.tagset.mode]} · {g.attested.length} distinct value
              {g.attested.length === 1 ? '' : 's'}
            </span>
            {g.bad.length > 0 ? (
              <span className="ml-auto flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {g.bad.length} outside the tagset
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-1.5 text-sm text-green-700">
                <Check className="h-4 w-4" /> All in the tagset
              </span>
            )}
          </div>

          {g.bad.map((row) => {
            const key = `${g.key}:${row.value}`;
            const open = expanded === key;
            const res = hits[key];
            const unknownParts = row.violations
              .filter((v) => v.reason === 'unknown')
              .map((v) => v.part);
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
                      {open ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  ) : (
                    // No searchable domain for this layer, so there is nothing
                    // to expand. Hold the column rather than offering a control
                    // that would open an empty panel.
                    <span className="h-6 w-6 shrink-0" />
                  )}
                  <code className="rounded bg-destructive/10 px-1.5 py-0.5 text-sm text-destructive">
                    {row.value}
                  </code>
                  <span className="text-xs text-muted-foreground">
                    {row.count} occurrence{row.count === 1 ? '' : 's'} ·{' '}
                    {reasonText(row.violations)}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {unknownParts.length > 0 && (
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
                      <Link to={`/projects/${projectId}?tab=bulk`}>Fix in Bulk Edit</Link>
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="border-t bg-muted/20 px-3 py-2">
                    {!res && <p className="text-sm text-muted-foreground">Finding occurrences…</p>}
                    {res?.failed && (
                      <p className="text-sm text-destructive">
                        Could not search for this value. Try again.
                      </p>
                    )}
                    {res && !res.failed && res.groups.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No occurrences found. The value may have been changed since the last check.
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
                              // tabTo writes the bare path for a default.
                              <Link
                                to={`/projects/${projectId}/documents/${grp.docId}`}
                                className="text-foreground hover:underline"
                              >
                                {grp.docName}
                              </Link>
                            )}
                            {grp.rows.length > 0 && (
                              <span className="font-normal text-muted-foreground">
                                ({grp.docHits})
                              </span>
                            )}
                          </p>
                          {grp.rows.map((r) => (
                            <Link
                              key={r.sentenceId}
                              to={hitTo(projectId, grp.docId, r.sentenceId)}
                              onClick={() => rememberCaret(grp.docId, r.sentenceId, r.hitBegin)}
                              className={cn(
                                'block rounded px-2 py-1 text-sm hover:bg-background',
                                'text-foreground no-underline',
                              )}
                            >
                              <span className="mr-2 text-xs text-muted-foreground">
                                {r.sentenceIndex + 1}
                              </span>
                              <MarkedText text={r.text} marks={r.marks} />
                              {r.translation && (
                                <span className="ml-2 text-xs italic text-muted-foreground">
                                  {r.translation}
                                </span>
                              )}
                            </Link>
                          ))}
                        </div>
                      ))}
                    {res && !res.failed && res.remainingDocs > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {res.remainingHits} more in {res.remainingDocs} document
                        {res.remainingDocs === 1 ? '' : 's'} not shown.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
