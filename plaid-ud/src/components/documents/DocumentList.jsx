import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Info, Plus } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { DocumentForm } from './DocumentForm';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { canEditProject, canManageProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { timeAgo, fullTimestamp } from '../../utils/formatTime.js';
import { notifyWarning } from '../../utils/feedback.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button } from '@ui/components/ui/button';
import { DataTable } from '@ui/components/ui/data-table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@ui/components/ui/tooltip';

const Spinner = () => (
  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-primary align-middle" />
);

export const DocumentList = () => {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [documents, setDocuments] = useState([]);
  useDocumentTitle(project?.name);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  // documentId -> word count. Docs with a word layer but no tokens are absent
  // (rendered as 0); `hasWordLayer` false means the project isn't UD-configured.
  const [wordCounts, setWordCounts] = useState({});
  const [hasWordLayer, setHasWordLayer] = useState(true);
  const [wordsLoading, setWordsLoading] = useState(true);
  const [myLastEdits, setMyLastEdits] = useState({});
  const [mineLoading, setMineLoading] = useState(true);
  const { user, getClient, logout } = useAuth();

  const fetchProjectAndDocuments = async () => {
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Fetch project and its documents (documents are no longer embedded
      // on the project; they come from the dedicated listDocuments endpoint).
      const [projectData, docsList] = await Promise.all([
        client.projects.get(projectId),
        client.projects.listDocuments(projectId),
      ]);
      setProject(projectData);
      setDocuments(docsList || []);
      setError('');
    } catch (err) {
      if (err.message === 'Not authenticated' || err.status === 401) {
        // Clear the rejected token before redirecting, else /login bounces back.
        logout();
        return;
      }
      setError('Failed to load project and documents');
      console.error('Error fetching project:', err);
    } finally {
      setLoading(false);
    }
  };

  // Once per project. `fetchProjectAndDocuments` is redefined every render,
  // so naming it here would refetch on every render.
  useEffect(() => {
    fetchProjectAndDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Per-document word counts: one aggregate query over the project's word-layer
  // tokens, grouped by document. Recomputed when the project (hence its word
  // layer) changes; the document list itself doesn't affect the query.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      setWordsLoading(true);
      const client = getClient();
      // "Words" = the morpheme layer: in the sentence>word>morpheme UD model the
      // morpheme layer holds the syntactic words (CoNLL-U token rows), which is
      // what a word count should mean.
      const wordLayerId = getUdLayerInfo(project).morphemeTokenLayer?.id;
      if (!wordLayerId || !client) {
        if (!cancelled) {
          setHasWordLayer(false);
          setWordCounts({});
          setWordsLoading(false);
        }
        return;
      }
      try {
        const res = await client.query({
          where: [['token', '?t', { layer: wordLayerId, doc: { var: '?d' } }]],
          return: { group: ['?d'], aggregates: [['count']] },
        });
        const byDoc = {};
        for (const [docId, n] of res?.results || []) byDoc[docId] = n;
        if (!cancelled) {
          setHasWordLayer(true);
          setWordCounts(byDoc);
        }
      } catch (err) {
        console.error('Word-count query failed:', err);
        if (!cancelled) {
          setHasWordLayer(false);
          setWordCounts({});
        }
      } finally {
        if (!cancelled) setWordsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, getClient]);

  // When this reader last touched each document, from the audit log in one
  // request. A failure here costs a column, not the list, so it warns and
  // leaves every cell empty. The response is a UUID-keyed map, which the
  // client already fetches with `skipResponseTransform` so the keys survive.
  useEffect(() => {
    const client = getClient();
    if (!client || !projectId) return;
    let cancelled = false;
    (async () => {
      setMineLoading(true);
      try {
        const edits = await client.projects.myLastEdits(projectId);
        if (!cancelled) setMyLastEdits(edits || {});
      } catch (err) {
        console.error('Last-edited query failed:', err);
        if (!cancelled) {
          setMyLastEdits({});
          notifyWarning(
            'Your last edit could not be loaded for the document list.',
            'Column unavailable',
          );
        }
      } finally {
        if (!cancelled) setMineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, getClient]);

  // A row links to the Annotate tab by default; but a document with no tokens
  // yet has nothing to annotate (the tab would just say "tokenize first"), so
  // point it at the Text Editor. Only divert once word counts have loaded and
  // confirm zero tokens — while they're still loading we keep the default so a
  // tokenized doc clicked early isn't mis-routed. (Deleting a document now lives
  // on a "Delete Document" button at the bottom of the Text Editor.)
  const rowHref = (documentId) => {
    const knownEmpty = hasWordLayer && !wordsLoading && (wordCounts[documentId] ?? 0) === 0;
    return `/projects/${projectId}/documents/${documentId}/${knownEmpty ? 'edit' : 'annotate'}`;
  };

  // Setting the project up for UD belongs HERE, at the door: a project is
  // either set up or it isn't, and finding that out is what clicking into it
  // should tell you. Opening a document is far too late — that used to bounce
  // the reader out of the editor mid-task.
  const configured = getUdLayerInfo(project).isConfigured;
  const canManage = canManageProject(project, user);
  useEffect(() => {
    if (project && !configured && canManage) {
      navigate(`/projects/${projectId}/configuration`, { replace: true });
    }
  }, [project, configured, canManage, projectId, navigate]);

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (!project) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        Project not found
      </div>
    );
  }

  // A maintainer is on their way to the setup page (the effect above). Everyone
  // else can't create layers, so they get a notice rather than a dead-end
  // redirect into a wizard they cannot complete.
  if (!configured) {
    return (
      <>
        <ProjectTabs projectId={projectId} project={project} />
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium">Not set up for UD</p>
              <p className="mt-1 text-muted-foreground">
                Ask a project maintainer to add UD support.
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Writers (and up) create/delete documents. Readers get a view-only list.
  // (Search, Project Settings, and Import/Export now live in the ProjectTabs bar.)
  const canEdit = canEditProject(project, user);

  const renderWords = (documentId) => {
    if (wordsLoading) return <Spinner />;
    if (!hasWordLayer) return '—';
    return (wordCounts[documentId] ?? 0).toLocaleString();
  };

  const renderMine = (documentId) => {
    if (mineLoading) return <Spinner />;
    const at = myLastEdits[documentId];
    if (!at) return '—';
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{timeAgo(at) || '—'}</span>
        </TooltipTrigger>
        <TooltipContent>{fullTimestamp(at)}</TooltipContent>
      </Tooltip>
    );
  };

  // Each cell holds a real anchor rather than the row holding an onClick, so
  // middle-click and cmd-click open the document the way they do on any link.
  const linked = (document, className, children) => (
    <Link to={rowHref(document.id)} className={className}>
      {children}
    </Link>
  );

  const columns = [
    {
      key: 'name',
      label: 'Document',
      sort: (d) => d.name?.toLowerCase() ?? '',
      className: 'p-0',
      render: (d) =>
        linked(
          d,
          'block px-4 py-3',
          <div className="min-w-0">
            <div className="truncate font-medium">{d.name}</div>
            <div className="truncate text-xs text-muted-foreground">ID: {d.id}</div>
          </div>,
        ),
    },
    {
      key: 'words',
      label: 'Words',
      sort: (d) => (hasWordLayer ? (wordCounts[d.id] ?? 0) : null),
      align: 'right',
      className: 'p-0',
      render: (d) =>
        linked(
          d,
          'block px-4 py-3 text-right tabular-nums text-muted-foreground',
          renderWords(d.id),
        ),
    },
    {
      key: 'updated',
      label: 'Updated',
      sort: (d) => (d.timeModified ? new Date(d.timeModified).getTime() : null),
      align: 'right',
      className: 'p-0',
      headerClassName: 'w-[130px]',
      render: (d) =>
        linked(
          d,
          'block whitespace-nowrap px-4 py-3 text-right text-muted-foreground',
          d.timeModified ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{timeAgo(d.timeModified) || '—'}</span>
              </TooltipTrigger>
              <TooltipContent>{fullTimestamp(d.timeModified)}</TooltipContent>
            </Tooltip>
          ) : (
            '—'
          ),
        ),
    },
    {
      key: 'mine',
      label: 'Your last edit',
      // Never touched is null, which orders as the smallest, so descending
      // puts the documents this reader has actually worked on at the top.
      sort: (d) => (myLastEdits[d.id] ? new Date(myLastEdits[d.id]).getTime() : null),
      align: 'right',
      className: 'p-0',
      headerClassName: 'w-[150px]',
      render: (d) =>
        linked(
          d,
          'block whitespace-nowrap px-4 py-3 text-right text-muted-foreground',
          renderMine(d.id),
        ),
    },
  ];

  return (
    <>
      <ProjectTabs projectId={projectId} project={project} />

      <div>
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Documents in {project.name}</h1>
          {canEdit && (
            <Button onClick={() => setShowCreateForm(true)}>
              <Plus className="h-4 w-4" /> New document
            </Button>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <DocumentForm
          projectId={projectId}
          isOpen={showCreateForm}
          onClose={() => setShowCreateForm(false)}
        />

        <TooltipProvider>
          <DataTable
            rows={documents}
            columns={columns}
            rowKey={(d) => d.id}
            id="documents"
            scope={projectId}
            rememberPage
            defaultSort={{ key: 'name', dir: 'asc' }}
            search={{
              placeholder: 'Search documents…',
              match: (d, q) => (d.name || '').toLowerCase().includes(q),
            }}
            noun="document"
            empty="No documents yet."
            noMatch={(q) => `No documents match “${q}”.`}
          />
        </TooltipProvider>
      </div>
    </>
  );
};
