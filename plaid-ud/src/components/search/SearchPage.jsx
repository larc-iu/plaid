import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Title, Anchor, Stack, Center, Loader, Alert, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { canManageProject } from '../../utils/permissions.js';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { parseAndCompile, parseGrs, looksLikeGrs, GrewError } from '../../grew/index.js';
import { planRewrite, applyRewrite } from '../../grew/rewrite/runner.js';
import { groupResults } from './grewToHighlight.js';
import { GrewQueryInput } from './GrewQueryInput.jsx';
import { GrewHelp } from './GrewHelp.jsx';
import { SearchResults } from './SearchResults.jsx';
import { RewritePreview } from './RewritePreview.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

// Ask for everything the query API will return. The server hard-caps an
// entities query at 100k rows and has no offset/cursor, so this is effectively
// "all matches"; the results are paged client-side in SearchResults.
const RESULT_LIMIT = 100000;

// One box, two jobs: a request searches, a request with `commands` (or `rule`
// blocks) previews a rewrite of every sentence it changes, to apply from the
// preview. The box decides which by its text (looksLikeGrs).
export const SearchPage = () => {
  const { projectId } = useParams();
  const { getClient, user } = useAuth();

  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  useDocumentTitle('Search', project?.name);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [queryText, setQueryText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [groups, setGroups] = useState([]);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [warnings, setWarnings] = useState([]);

  // Rewrite mode: the plan under preview and the rows picked to apply.
  const [plan, setPlan] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [progress, setProgress] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const client = getClient();
        if (!client) throw new Error('Not authenticated');
        const [proj, docs] = await Promise.all([
          client.projects.get(projectId),
          client.projects.listDocuments(projectId).catch(() => []),
        ]);
        if (cancelled) return;
        setProject(proj);
        setDocuments(docs || []);
        setLoadError('');
      } catch (err) {
        if (!cancelled) setLoadError('Failed to load this project. You may not have access to it.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const layerInfo = useMemo(() => getUdLayerInfo(project), [project]);
  const docName = useCallback((id) => documents.find((d) => d.id === id)?.name || id, [documents]);
  const isRewrite = useMemo(() => looksLikeGrs(queryText), [queryText]);
  const canApply = canManageProject(project, user);

  const reportError = useCallback((err) => {
    if (err instanceof GrewError) {
      setError(err);
    } else if (err?.status === 408) {
      setError({
        name: 'ServerError',
        message: 'The query was too broad and timed out. Add more constraints.',
      });
    } else {
      setError({ name: 'ServerError', message: err?.message || 'The request failed.' });
    }
  }, []);

  const runSearch = useCallback(async () => {
    const {
      query,
      warnings: warns,
      impossible,
    } = parseAndCompile(queryText, layerInfo, { projectId, limit: RESULT_LIMIT });
    setWarnings(warns || []);
    if (impossible) {
      setGroups([]);
      setCount(0);
      setTruncated(false);
      setSearched(true);
      return;
    }
    const res = await getClient().query(query);
    setGroups(
      groupResults(res.results, layerInfo.sentenceTokenLayer.id, layerInfo.morphemeTokenLayer.id),
    );
    setCount(res.count ?? 0);
    setTruncated(!!res.truncated);
    setSearched(true);
  }, [queryText, layerInfo, projectId, getClient]);

  const runPreview = useCallback(async () => {
    const grs = parseGrs(queryText);
    const result = await planRewrite(getClient(), { project, user, layerInfo, grs }, setProgress);
    const rows = result.rows.map((r) => ({ ...r, key: `${r.docId}:${r.id}` }));
    setPlan({ ...result, rows, grs });
    setSelected(new Set(rows.filter((r) => !r.error).map((r) => r.key)));
  }, [queryText, project, user, layerInfo, getClient]);

  const run = useCallback(async () => {
    if (!queryText.trim() || running) return;
    setRunning(true);
    setError(null);
    setPlan(null);
    setSearched(false);
    try {
      if (isRewrite) await runPreview();
      else await runSearch();
    } catch (err) {
      reportError(err);
    } finally {
      setProgress('');
      setRunning(false);
    }
  }, [queryText, running, isRewrite, runPreview, runSearch, reportError]);

  const apply = useCallback(async () => {
    if (!plan || applying) return;
    setApplying(true);
    try {
      const rows = plan.rows.filter((r) => selected.has(r.key));
      const names = plan.grs.rules.map((r) => r.name).join(', ');
      const out = await applyRewrite(
        getClient(),
        { rows, docs: plan.docs, label: `Rewrite: ${names}` },
        setProgress,
      );
      const applied = `${out.sentencesChanged} sentence${out.sentencesChanged === 1 ? '' : 's'} in ${out.docsChanged} document${out.docsChanged === 1 ? '' : 's'}`;
      if (out.failed) {
        const why = out.failed.status === 409 ? 'it changed since the preview' : out.failed.message;
        notifyError(`Stopped at ${out.failed.docName}: ${why}. Applied to ${applied}.`);
      } else {
        notifySuccess(`Changed ${applied}.`);
      }
      // Show what the rules would still change now that these are applied.
      await runPreview();
    } catch (err) {
      notifyError(err?.message || 'The changes could not be applied.');
    } finally {
      setProgress('');
      setApplying(false);
    }
  }, [plan, applying, selected, getClient, runPreview]);

  const sentenceHref = useCallback(
    (docId, sentenceId) =>
      `/projects/${projectId}/documents/${docId}/annotate?sent=${encodeURIComponent(sentenceId)}`,
    [projectId],
  );

  if (loading)
    return (
      <Center py={48}>
        <Loader />
      </Center>
    );
  if (loadError) return <Alert color="red">{loadError}</Alert>;

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <Stack gap="lg">
        <Title order={2}>Search {project?.name}</Title>

        {!layerInfo.isConfigured ? (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Not available">
            This project isn’t configured for UD annotation yet, so dependency search isn’t
            available.{' '}
            <Anchor component={Link} to={`/projects/${projectId}/configuration`}>
              Set up its layers
            </Anchor>{' '}
            first.
          </Alert>
        ) : (
          <>
            <GrewHelp onPick={(q) => setQueryText(q)} />
            <GrewQueryInput
              value={queryText}
              onChange={setQueryText}
              onRun={run}
              running={running}
              error={error}
              action={isRewrite ? 'Preview changes' : 'Search'}
            />
            {progress && (
              <Text size="sm" c="dimmed">
                {progress}
              </Text>
            )}
            {plan ? (
              <RewritePreview
                rows={plan.rows}
                selected={selected}
                onSelect={setSelected}
                hrefFor={sentenceHref}
                canApply={canApply}
                busy={applying}
                onApply={apply}
              />
            ) : (
              <SearchResults
                groups={groups}
                count={count}
                truncated={truncated}
                warnings={warnings}
                searched={searched}
                docName={docName}
                hrefFor={sentenceHref}
              />
            )}
          </>
        )}
      </Stack>
    </>
  );
};
