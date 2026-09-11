import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from '../projects/useManagedProject.js';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { notifyError, notifySuccess } from '../../utils/feedback.jsx';
import { getUdLayerInfo, UD_NAMESPACE } from '../../utils/udLayerUtils.js';
import { baseRel } from '../../utils/udVocab.js';
import { MODES } from '../../utils/udVocabMode.js';
import {
  spanValueCounts,
  relationValueCounts,
  spanValueSentences,
  relationValueSentences,
  seedCandidates,
  featureSeedCandidates,
} from '../../domain/validationQueries.js';

// What the project has stored that its own vocabularies do not list.
//
// This view exists because a closed list is enforced where a person types and
// NOWHERE else: an import, a parser, the assistant and a direct API call all
// reach the same span layer without passing that check, and that is deliberate.
// Off-list machine output is a signal. This is where you find out what it said.
//
// It costs one aggregate query per field: the server returns the field's whole
// value inventory as [value, count] and the diff against the list happens here,
// so nothing loads a document until you click a value and ask where it is.

const FIELDS = [
  { key: 'upos', label: 'UPOS', layer: 'uposLayer', kind: 'span' },
  { key: 'xpos', label: 'XPOS', layer: 'xposLayer', kind: 'span' },
  { key: 'deprel', label: 'Dependency relations', layer: 'relationLayer', kind: 'relation' },
  { key: 'feats', label: 'Features', layer: 'featuresLayer', kind: 'feats' },
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Where an off-list value is, once someone has opened it: the documents it is
// in, and a link into each sentence. The links are numbered by the order the
// query returned them, so they are called occurrences: their position in the
// document is not something this screen knows, and a label saying "sentence 2"
// over the seventeenth sentence is worse than no number at all.
const Occurrences = ({ found, projectId }) => (
  <div className="border-t bg-muted/20 px-3 py-2">
    {!found && <p className="text-sm text-muted-foreground">Finding it…</p>}
    {found === 'failed' && (
      <p className="text-sm text-destructive">Could not search for this value. Try again.</p>
    )}
    {Array.isArray(found) &&
      found.map((doc) => (
        <p key={doc.docId} className="mb-1 flex flex-wrap items-center gap-1.5 text-xs last:mb-0">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{doc.docName}</span>
          {doc.sentences.map((sentId, i) => (
            <Link
              key={sentId}
              to={`/projects/${projectId}/documents/${doc.docId}/annotate?sent=${sentId}`}
              className="rounded bg-background px-1.5 py-0.5 hover:underline"
            >
              occurrence {i + 1}
            </Link>
          ))}
        </p>
      ))}
    {Array.isArray(found) && found.length === 0 && (
      <p className="text-sm text-muted-foreground">
        No occurrences found. It may have been changed since the check.
      </p>
    )}
  </div>
);

export const ProjectValidation = () => {
  const { project, projectId, loading, canConfigure } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();

  useDocumentTitle('Validation', project?.name);

  const layerInfo = useMemo(() => (project ? getUdLayerInfo(project) : null), [project]);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null); // `${field}:${value}`
  const [where, setWhere] = useState({});
  const [adding, setAdding] = useState(null);

  const scan = useCallback(async () => {
    if (!client || !layerInfo?.isConfigured) return;
    setBusy(true);
    setExpanded(null);
    setWhere({});
    try {
      const out = [];
      for (const field of FIELDS) {
        const layer = layerInfo[field.layer];
        if (!layer) continue;
        const query =
          field.kind === 'relation'
            ? relationValueCounts(projectId, layer.id)
            : spanValueCounts(projectId, layer.id);
        const res = await client.query(query);
        const counts = res?.results || [];
        const enforced = layerInfo.modes[field.key] === MODES.CLOSED;
        if (field.kind === 'feats') {
          out.push({
            ...field,
            layerId: layer.id,
            enforced,
            features: featureSeedCandidates(counts, layerInfo.vocab.featureInventory.map),
            values: [],
          });
        } else {
          out.push({
            ...field,
            layerId: layer.id,
            enforced,
            values: seedCandidates(
              counts,
              layerInfo.vocab[field.key],
              field.key === 'deprel' ? (a, b) => baseRel(a) === baseRel(b) : undefined,
            ),
            features: [],
          });
        }
      }
      setReport(out);
    } catch (err) {
      console.error('Validation scan failed:', err);
      notifyError(err.message || 'Could not read the project.', 'Scan failed');
    } finally {
      setBusy(false);
    }
  }, [client, layerInfo, projectId]);

  useEffect(() => {
    scan();
  }, [scan]);

  // Where one value is, asked only when its row is opened.
  const locate = useCallback(
    async (field, value) => {
      const key = `${field.key}:${value}`;
      setExpanded((prev) => (prev === key ? null : key));
      if (where[key]) return;
      try {
        const sentenceLayerId = layerInfo.sentenceTokenLayer.id;
        const query =
          field.kind === 'relation'
            ? relationValueSentences(projectId, sentenceLayerId, field.layerId, value)
            : spanValueSentences(projectId, sentenceLayerId, field.layerId, value);
        const res = await client.query(query);
        const byDoc = new Map();
        for (const [docId, sentId] of res?.results || []) {
          const id = String(docId);
          if (!byDoc.has(id)) byDoc.set(id, []);
          byDoc.get(id).push(String(sentId));
        }
        const docs = await client.projects.listDocuments(projectId);
        const nameOf = new Map((docs || []).map((d) => [d.id, d.name]));
        setWhere((prev) => ({
          ...prev,
          [key]: [...byDoc.entries()].map(([docId, sentences]) => ({
            docId,
            docName: nameOf.get(docId) || '(untitled)',
            sentences,
          })),
        }));
      } catch (err) {
        console.error('Could not locate the value:', err);
        setWhere((prev) => ({ ...prev, [key]: 'failed' }));
      }
    },
    [client, layerInfo, projectId, where],
  );

  // Adopt every off-list value into the vocabulary. Offered, never imposed: a
  // project may well want the list to stay as it is and the values gone.
  const adopt = useCallback(
    async (field) => {
      setAdding(field.key);
      try {
        if (field.kind === 'feats') {
          const inventory = layerInfo.vocab.featureInventory.list.map((e) => ({
            key: e.key,
            values: [...(e.values || [])],
          }));
          const byKey = new Map(inventory.map((e) => [e.key, e]));
          for (const entry of field.features) {
            const add = entry.values.map((v) => v.value);
            if (byKey.has(entry.key)) {
              const existing = byKey.get(entry.key);
              existing.values = [...new Set([...existing.values, ...add])];
            } else {
              inventory.push({ key: entry.key, values: add });
            }
          }
          await client.spanLayers.setConfig(field.layerId, UD_NAMESPACE, 'inventory', inventory);
        } else {
          const next = [...(layerInfo.vocab[field.key] || []), ...field.values.map((v) => v.value)];
          const layers = field.kind === 'relation' ? client.relationLayers : client.spanLayers;
          await layers.setConfig(field.layerId, UD_NAMESPACE, 'vocab', [...new Set(next)]);
        }
        notifySuccess(`${field.label} updated`);
        window.location.reload();
      } catch (err) {
        console.error('Could not add the values:', err);
        notifyError(err.message || 'Could not add the values.', 'Not saved');
      } finally {
        setAdding(null);
      }
    },
    [client, layerInfo],
  );

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!project || !canConfigure) return null;

  const configured = layerInfo?.isConfigured;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <ProjectTabs projectId={projectId} project={project} />

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Validation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Values stored in this project that its vocabularies do not list. A parser, an import or
            the API can write one whatever the list says, which is why they arrive here rather than
            being refused.
          </p>
        </div>
        <Button variant="outline" onClick={scan} disabled={busy || !configured}>
          {busy ? 'Checking…' : 'Check again'}
        </Button>
      </div>

      {!configured && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Set up the project&apos;s UD layers first.
        </p>
      )}

      {configured && busy && !report && (
        <p className="text-sm text-muted-foreground">Reading the project…</p>
      )}

      {configured &&
        report?.map((field) => {
          const count =
            field.kind === 'feats'
              ? field.features.reduce((n, e) => n + e.values.length, 0)
              : field.values.length;
          return (
            <div key={field.key} className="mb-4 rounded-lg border">
              <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <h2 className="font-medium">{field.label}</h2>
                  <Badge variant={field.enforced ? 'secondary' : 'outline'}>
                    {field.enforced ? 'closed' : 'open'}
                  </Badge>
                </div>
                {count > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={adding === field.key}
                    onClick={() => adopt(field)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add {plural(count, 'value', 'values')}
                  </Button>
                )}
              </div>

              {count === 0 ? (
                <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-green-600" />
                  Everything stored is on the list.
                </p>
              ) : field.kind === 'feats' ? (
                <div className="px-3 py-2">
                  {field.features.map((entry) => (
                    <div key={entry.key} className="mb-2 last:mb-0">
                      <p className="text-sm font-medium">
                        {entry.key}
                        {!entry.known && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            not in the inventory
                          </span>
                        )}
                      </p>
                      <ul className="ml-4">
                        {entry.values.map((v) => {
                          // The span stores the whole `Key=Value` string, which
                          // is what the same query looks for.
                          const pair = `${entry.key}=${v.value}`;
                          const key = `${field.key}:${pair}`;
                          const open = expanded === key;
                          return (
                            <li key={v.value}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted/40"
                                onClick={() => locate(field, pair)}
                              >
                                {open ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                                <code>{v.value}</code>
                                <span className="text-xs">{plural(v.count, 'time', 'times')}</span>
                              </button>
                              {open && <Occurrences found={where[key]} projectId={projectId} />}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <ul>
                  {field.values.map((v) => {
                    const key = `${field.key}:${v.value}`;
                    const open = expanded === key;
                    const found = where[key];
                    return (
                      <li key={v.value} className="border-b last:border-b-0">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/40"
                          onClick={() => locate(field, v.value)}
                        >
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                          <code>{v.value}</code>
                          <span className="text-xs text-muted-foreground">
                            {plural(v.count, 'time', 'times')}
                          </span>
                        </button>
                        {open && <Occurrences found={found} projectId={projectId} />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
    </div>
  );
};
