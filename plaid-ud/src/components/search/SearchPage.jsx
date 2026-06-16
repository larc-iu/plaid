import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Title, Anchor, Stack, Center, Loader, Alert,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { parseAndCompile, GrewError } from '../../grew/index.js';
import { groupResults } from './grewToHighlight.js';
import { GrewQueryInput } from './GrewQueryInput.jsx';
import { GrewHelp } from './GrewHelp.jsx';
import { SearchResults } from './SearchResults.jsx';

export const SearchPage = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { getClient } = useAuth();

  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
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
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const layerInfo = useMemo(() => getUdLayerInfo(project), [project]);
  const docName = useCallback(
    (id) => documents.find(d => d.id === id)?.name || id,
    [documents],
  );

  const run = useCallback(async () => {
    if (!queryText.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const { query, warnings: warns, impossible } = parseAndCompile(queryText, layerInfo, { projectId, limit: 200 });
      setWarnings(warns || []);
      if (impossible) {
        setGroups([]); setCount(0); setTruncated(false); setSearched(true);
        return;
      }
      const res = await getClient().query(query);
      setGroups(groupResults(res.results, layerInfo.sentenceTokenLayer.id, layerInfo.morphemeTokenLayer.id));
      setCount(res.count ?? 0);
      setTruncated(!!res.truncated);
      setSearched(true);
    } catch (err) {
      if (err instanceof GrewError) {
        setError(err);
      } else if (err?.status === 408) {
        setError({ name: 'ServerError', message: 'The query was too broad and timed out. Add more constraints.' });
      } else {
        setError({ name: 'ServerError', message: err?.message || 'The search request failed.' });
      }
    } finally {
      setRunning(false);
    }
  }, [queryText, running, layerInfo, projectId, getClient]);

  const openSentence = useCallback((docId, sentenceId) => {
    navigate(`/projects/${projectId}/documents/${docId}/annotate?sent=${encodeURIComponent(sentenceId)}`);
  }, [navigate, projectId]);

  if (loading) return <Center py={48}><Loader /></Center>;
  if (loadError) return <Alert color="red">{loadError}</Alert>;

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <Stack gap="lg">
        <Title order={2}>Search {project?.name}</Title>

        {!layerInfo.isConfigured ? (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Not available">
            This project isn’t configured for UD annotation yet, so dependency search isn’t available.{' '}
            <Anchor component={Link} to={`/projects/${projectId}/configuration`}>Set up its layers</Anchor> first.
          </Alert>
        ) : (
          <>
            <GrewHelp onPick={(q) => setQueryText(q)} />
            <GrewQueryInput value={queryText} onChange={setQueryText} onRun={run} running={running} error={error} />
            <SearchResults
              groups={groups}
              count={count}
              truncated={truncated}
              warnings={warnings}
              searched={searched}
              docName={docName}
              onOpen={openSentence}
            />
          </>
        )}
      </Stack>
    </>
  );
};
