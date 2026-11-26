import { cn } from '@ui/lib/utils';
import { FORM_PAGE_WIDTH } from '@ui/lib/pageWidth.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { APP_ROUTES } from '../../appRoutes.js';
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Plus } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Badge } from '@ui/components/ui/badge';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { ValidationHeader } from '@ui/components/shared/ValidationHeader.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useManagedProject } from '@ui/hooks/useManagedProject.js';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { notifyError, notifySuccess } from '../../utils/feedback.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { UD_NAMESPACE } from '../../domain/udConfig.js';
import { expectStored, isConfigConflict } from '@ui/domain/configCells.js';
import { baseRel, withAddedValues } from '../../utils/udVocab.js';
import { MODES } from '../../utils/udVocabMode.js';
import { queueVocabCells } from '../../domain/udVocabSave.js';
import {
  spanValueCounts,
  relationValueCounts,
  spanValueSentences,
  relationValueSentences,
  seedCandidates,
  featureSeedCandidates,
} from '../../domain/validationQueries.js';
import { t, msg } from '@ui/lib/i18n.js';

// What the project has stored that its own vocabularies do not list.
//
// This view exists because a closed list does not hold everything: an import
// and unreviewed parser output are exempt from the server's rule, and a
// feature inventory is the app's own check. Off-list machine output is a
// signal. This is where you find out what it said.
//
// It costs one aggregate query per field: the server returns the field's whole
// value inventory as [value, count] and the diff against the list happens here,
// so nothing loads a document until you click a value and ask where it is.

// The dependency relation list governs the tree and the enhanced graph alike,
// so its row reads the enhanced layer too (`also`, H17-2). A suppressor has no
// value, and the queries ask only for values. `layer` holds the list.
// `updated` is the toast once its values are added to the list.
const FIELDS = [
  {
    key: 'upos',
    label: 'UPOS', // i18n-ignore: the UD name, the same in every language
    updated: msg('UPOS updated'),
    layer: 'uposLayer',
    kind: 'span',
  },
  {
    key: 'xpos',
    label: 'XPOS', // i18n-ignore: the UD name, the same in every language
    updated: msg('XPOS updated'),
    layer: 'xposLayer',
    kind: 'span',
  },
  {
    key: 'deprel',
    label: msg('Dependency relations'),
    updated: msg('Dependency relations updated'),
    layer: 'relationLayer',
    also: 'enhancedRelationLayer',
    kind: 'relation',
  },
  {
    key: 'feats',
    label: msg('Features'),
    updated: msg('Features updated'),
    layer: 'featuresLayer',
    kind: 'feats',
  },
];

// [value, count] pairs summed over several layers' answers.
const summed = (answers) => {
  const total = new Map();
  for (const counts of answers) {
    for (const [value, count] of counts) {
      total.set(value, (total.get(value) || 0) + (Number(count) || 0));
    }
  }
  return [...total.entries()];
};

// Where an off-list value is, once someone has opened it: the documents it is
// in, and a link into each sentence. The links are numbered by the order the
// query returned them, so they are called occurrences: their position in the
// document is not something this screen knows, and a label saying "sentence 2"
// over the seventeenth sentence is worse than no number at all.
const Occurrences = ({ found, projectId }) => (
  <div className="border-t bg-muted/20 px-3 py-2">
    {!found && <p className="text-sm text-muted-foreground">{t('Finding it…')}</p>}
    {found === 'failed' && (
      <p className="text-sm text-destructive">{t('Failed to search for this value.')}</p>
    )}
    {Array.isArray(found) &&
      found.map((doc) => (
        <p key={doc.docId} className="mb-1 flex flex-wrap items-center gap-1.5 text-xs last:mb-0">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{doc.docName}</span>
          {doc.sentences.map((sentId, i) => (
            <Link
              key={sentId}
              to={APP_ROUTES.sentence(projectId, doc.docId, sentId)}
              className="rounded bg-background px-1.5 py-0.5 hover:underline"
            >
              {t('occurrence {n}', { n: i + 1 })}
            </Link>
          ))}
        </p>
      ))}
    {Array.isArray(found) && found.length === 0 && (
      <p className="text-sm text-muted-foreground">
        {t('No occurrences found. It may have been changed since the check.')}
      </p>
    )}
  </div>
);

export const ProjectValidation = () => {
  const { project, projectId, loading, canConfigure, fetchProject } = useManagedProject();
  const { getClient } = useAuth();
  const client = getClient();

  useDocumentTitle(t('Validation'), project?.name);

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
        if (!layerInfo[field.layer]) continue;
        const layerIds = [field.layer, field.also]
          .map((name) => layerInfo[name]?.id)
          .filter(Boolean);
        const answers = [];
        for (const layerId of layerIds) {
          const query =
            field.kind === 'relation'
              ? relationValueCounts(projectId, layerId)
              : spanValueCounts(projectId, layerId);
          const res = await client.query(query);
          answers.push(res?.results || []);
        }
        const counts = summed(answers);
        const enforced = layerInfo.modes[field.key] === MODES.CLOSED;
        if (field.kind === 'feats') {
          out.push({
            ...field,
            layerIds,
            enforced,
            features: featureSeedCandidates(counts, layerInfo.vocab.featureInventory.map),
            values: [],
          });
        } else {
          out.push({
            ...field,
            layerIds,
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
      notifyError(err, t('Failed to read the project'));
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
        const byDoc = new Map();
        for (const layerId of field.layerIds) {
          const query =
            field.kind === 'relation'
              ? relationValueSentences(projectId, sentenceLayerId, layerId, value)
              : spanValueSentences(projectId, sentenceLayerId, layerId, value);
          const res = await client.query(query);
          for (const [docId, sentId] of res?.results || []) {
            const id = String(docId);
            if (!byDoc.has(id)) byDoc.set(id, []);
            const sentences = byDoc.get(id);
            if (!sentences.includes(String(sentId))) sentences.push(String(sentId));
          }
        }
        const docs = await client.projects.listDocuments(projectId);
        const nameOf = new Map((docs || []).map((d) => [d.id, d.name]));
        setWhere((prev) => ({
          ...prev,
          [key]: [...byDoc.entries()].map(([docId, sentences]) => ({
            docId,
            docName: nameOf.get(docId) || t('(untitled)'),
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
  // project may well want the list to stay as it is and the values gone. The
  // values are added to the list as stored: a write refused because someone
  // saved the list since is made again to what they saved. The project is then
  // read again, quietly, and the new project runs the check again (`scan`
  // follows `layerInfo`).
  const adopt = useCallback(
    async (field) => {
      setAdding(field.key);
      const attempt = async (proj) => {
        const cell = withAddedValues(getUdLayerInfo(proj), field);
        if (field.kind === 'feats') {
          await client.spanLayers.setConfig(
            cell.entity.id,
            UD_NAMESPACE,
            cell.key,
            cell.value,
            undefined,
            expectStored(cell.entity, UD_NAMESPACE, cell.key),
          );
        } else {
          await client.batched((b) => queueVocabCells(b, proj, [cell]));
        }
      };
      try {
        try {
          await attempt(project);
        } catch (err) {
          if (!isConfigConflict(err)) throw err;
          await attempt(await client.projects.get(projectId));
        }
        notifySuccess(t(field.updated));
        await fetchProject({ quiet: true });
      } catch (err) {
        console.error('Failed to add the values:', err);
        notifyError(err, t('Failed to add the values'));
      } finally {
        setAdding(null);
      }
    },
    [client, project, projectId, fetchProject],
  );

  if (loading) return <Loading />;
  if (!project || !canConfigure) return null;

  const configured = layerInfo?.isConfigured;

  return (
    <div className="w-full">
      <ProjectTabs projectId={projectId} project={project} />
      {/* The same width in every app: a form's, from the page's left edge. */}
      <div className={cn('w-full', FORM_PAGE_WIDTH)}>
        <ValidationHeader
          description={t(
            'Values in this project that its lists do not include. Imports and parsers may write values outside the lists.',
          )}
          busy={busy}
          disabled={!configured}
          onCheck={scan}
        />

        {!configured && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {t('Set the project up for UD first.')}
          </p>
        )}

        {configured && busy && !report && (
          <Loading label={t('Reading the project…')} className="p-0" />
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
                    <h3 className="font-medium">{t(field.label)}</h3>
                    <Badge variant={field.enforced ? 'secondary' : 'outline'}>
                      {field.enforced ? t('closed') : t('open')}
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
                      {t('Add {n, plural, one {# value} other {# values}}', { n: count })}
                    </Button>
                  )}
                </div>

                {count === 0 ? (
                  <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                    <Check className="h-4 w-4 text-success" />
                    {t('Everything stored is on the list.')}
                  </p>
                ) : field.kind === 'feats' ? (
                  <div className="px-3 py-2">
                    {field.features.map((entry) => (
                      <div key={entry.key} className="mb-2 last:mb-0">
                        <p className="text-sm font-medium">
                          {entry.key}
                          {!entry.known && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {t('not in the inventory')}
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
                                  <span className="text-xs">
                                    {t('{n, plural, one {# time} other {# times}}', { n: v.count })}
                                  </span>
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
                            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                            <code>{v.value}</code>
                            <span className="text-xs text-muted-foreground">
                              {t('{n, plural, one {# time} other {# times}}', { n: v.count })}
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
    </div>
  );
};
