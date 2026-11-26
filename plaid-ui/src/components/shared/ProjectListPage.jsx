import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { appRoutes } from '../../lib/uiConfig.js';
import { notifyWarning } from '../../lib/notify.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../ui/button';
import { LinkedListPage, CountCell, TimeCell, NewLinkButton } from './LinkedListPage.jsx';
import { wordCountsByProject } from '../../domain/layerCounts.js';
import { compareNames, textIncludes } from '../../domain/collation.js';
import { ProjectTartan } from './ProjectTartan.jsx';

/**
 * Every project this reader can see, and the way into a new one.
 *
 * `wordLayerId(project)` is the app's: which token layer a word count means
 * differs (plaid-ud counts its morpheme layer, where the CoNLL-U rows live).
 * `seedLayerId(project)` is plaid-ud's token layer, counted for a document
 * with no words yet, as its document list does (see wordCountsByProject).
 * `wordValue(project)`, optional, keeps the count to tokens whose surface
 * matches it (plaid-igt's ignored-tokens rule).
 * `note(project)`, optional, is a few words the app shows after a project's
 * name, or null.
 * `newProject` is the label on the button and in the empty state. The button
 * opens `form`, the app's new-project dialog, or links to `newProjectTo`, the
 * app's new-project page.
 */
export const ProjectListPage = ({
  wordLayerId,
  seedLayerId,
  wordValue,
  note,
  newProject,
  form: NewProject,
  newProjectTo,
}) => {
  useDocumentTitle(t('Projects'));
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // projectId -> word count (number), or null when the project has no word
  // layer. `undefined` (missing key) means "still loading".
  const [wordCounts, setWordCounts] = useState({});
  const [wordsLoading, setWordsLoading] = useState(true);
  const { getClient, logout } = useAuth();
  const navigate = useNavigate();
  const routes = appRoutes();

  const fetchProjects = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) throw new Error('Not authenticated');
      setProjects(await client.projects.list());
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // A rejected token is invalid: log out (which clears the stored token)
        // before redirecting, so /login does not bounce straight back here.
        logout('expired');
        return;
      }
      setError(t('Failed to load the projects'));
      console.error('Error fetching projects:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once on mount. `fetchProjects` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projects.length) return undefined;
    const client = getClient();
    if (!client) return undefined;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      try {
        const counts = await wordCountsByProject(
          client,
          projects,
          wordLayerId,
          seedLayerId,
          wordValue,
        );
        if (!cancelled) setWordCounts(counts);
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) {
          setWordCounts({}); // leave counts unknown -> "—"
          notifyWarning(
            t('Failed to load word counts for the project list.'),
            t('Word counts unavailable'),
          );
        }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projects, getClient, wordLayerId, seedLayerId, wordValue]);

  const handleProjectCreated = (project) => {
    setShowCreateForm(false);
    // Jump straight into the new project. If the id is somehow missing, fall
    // back to refreshing the list in place.
    if (project?.id) navigate(routes.documents(project.id));
    else fetchProjects();
  };

  const columns = [
    {
      key: 'name',
      label: t('Project'),
      fill: true,
      sort: (p) => p.name ?? '',
      compare: compareNames,
      cell: (p) => (
        <div className="flex min-w-0 items-center gap-2">
          <ProjectTartan project={p} size={16} className="shrink-0" />
          <div className="truncate font-text font-medium" title={p.name}>
            {p.name}
          </div>
          {note?.(p) && <span className="shrink-0 text-xs text-muted-foreground">{note(p)}</span>}
        </div>
      ),
    },
    {
      key: 'documents',
      label: t('Documents'),
      sort: (p) => p.documentCount ?? 0,
      align: 'right',
      nowrap: true,
      cell: (p) => p.documentCount ?? 0,
    },
    {
      key: 'words',
      label: t('Words'),
      // A project with no word layer counts as the smallest, which is what a
      // blank means here.
      sort: (p) => wordCounts[p.id] ?? null,
      align: 'right',
      nowrap: true,
      cell: (p) => <CountCell value={wordCounts[p.id]} loading={wordsLoading} />,
    },
    {
      key: 'updated',
      label: t('Updated'),
      sort: (p) => (p.lastModified ? new Date(p.lastModified).getTime() : null),
      align: 'right',
      nowrap: true,
      cell: (p) => <TimeCell at={p.lastModified} />,
    },
  ];

  return (
    <>
      {NewProject && (
        <NewProject
          isOpen={showCreateForm}
          onClose={() => setShowCreateForm(false)}
          onSuccess={handleProjectCreated}
        />
      )}

      <LinkedListPage
        title={t('Projects')}
        action={
          newProjectTo ? (
            <NewLinkButton to={newProjectTo}>
              <Plus className="h-4 w-4" /> {newProject}
            </NewLinkButton>
          ) : (
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus className="h-4 w-4" /> {newProject}
            </Button>
          )
        }
        href={(p) => routes.documents(p.id)}
        rows={projects}
        columns={columns}
        loading={loading}
        error={error}
        onRetry={fetchProjects}
        empty={{
          title: t('No projects yet'),
          hint: t(
            "Create one with {action}, or ask a project's maintainer for an invitation link.",
            { action: newProject },
          ),
        }}
        tableId="projects"
        countLabel={(v) => t('{total} {n, plural, one {project} other {projects}}', v)}
        noMatch={t('No projects match.')}
        defaultSort={{ key: 'updated', dir: 'desc' }}
        search={{
          placeholder: t('Search projects…'),
          match: (p, q) => textIncludes(p.name || '', q),
        }}
      />
    </>
  );
};
