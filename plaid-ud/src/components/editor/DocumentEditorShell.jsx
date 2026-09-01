import { useState, useEffect, useCallback } from 'react';
import { useParams, useLocation, Outlet } from 'react-router-dom';
import { Box, Center, Loader, Alert } from '@mantine/core';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';

// Parent route of the three document-editor tabs (/edit, /annotate, /export).
// It owns the project + ConlluDocument load and renders the breadcrumbs and the
// tab strip, so a tab switch swaps ONLY the body: the shell's route params don't
// change, so React Router keeps it mounted.
//
// Each tab used to be a sibling route that rendered its own copy of
// `DocumentTabs` *behind its own loading gate*, so every switch unmounted the
// chrome, flashed a bare spinner where the whole page had been, and
// re-downloaded the entire document. Keep the chrome here, above the loading
// gate, and keep the three tabs children of this route — that is the whole
// point of the shell.

// The annotation editor is full-bleed and supplies its own padding; the other
// two sit in `Layout`'s centered container, which already pads them.
const isWideRoute = (pathname) => pathname.includes('/annotate');

export const DocumentEditorShell = () => {
  const { projectId, documentId } = useParams();
  const { pathname } = useLocation();
  const { getClient, logout } = useAuth();

  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The annotation editor's history drawer pushes its content right rather than
  // overlaying it. The chrome lives up here now, so it has to move too — the
  // child publishes the offset through the outlet context.
  const [chromeOffset, setChromeOffset] = useState(0);

  // Re-render on any mutation of the shared document (see useConlluDocument).
  useConlluDocument(doc);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const client = getClient();
      if (!client) {
        logout();
        return;
      }
      try {
        setLoading(true);
        const [projectData, next] = await Promise.all([
          client.projects.get(projectId),
          ConlluDocument.load(client, projectId, documentId),
        ]);
        if (cancelled) return;
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          logout();
          return;
        }
        setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
        console.error('Error fetching data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  // Resync after something outside this app changed the document (an NLP
  // service parse, mainly). The ConlluDocument is refreshed in place so the
  // annotation grid isn't remounted.
  const reload = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    try {
      const [projectData] = await Promise.all([
        client.projects.get(projectId),
        doc ? doc.reload() : Promise.resolve(),
      ]);
      setProject(projectData);
    } catch (err) {
      if (err.status === 401) {
        logout();
        return;
      }
      console.error('Error refreshing document:', err);
    }
  }, [projectId, doc, getClient, logout]);

  const wide = isWideRoute(pathname);

  return (
    <Box style={{ width: '100%' }}>
      {/* Chrome: rendered unconditionally, including while the document loads.
          That is what stops the tab switch from blanking the page. */}
      <Box style={{ marginLeft: chromeOffset, transition: 'margin-left 300ms ease' }}>
        <Box px={wide ? 'lg' : undefined} pt={wide ? 'md' : undefined}>
          <DocumentTabs
            projectId={projectId}
            documentId={documentId}
            project={project}
            document={doc?.raw}
          />
        </Box>
      </Box>

      {loading && (
        <Center py={48}>
          <Loader />
        </Center>
      )}

      {!loading && loadError && (
        <Box px={wide ? 'lg' : undefined}>
          <Alert color="red">{loadError}</Alert>
        </Box>
      )}

      {!loading && !loadError && (!doc || !project) && (
        <Box px={wide ? 'lg' : undefined}>
          <Alert color="red">Document or project not found</Alert>
        </Box>
      )}

      {!loading && !loadError && doc && project && (
        <Outlet context={{ projectId, documentId, doc, project, reload, setChromeOffset }} />
      )}
    </Box>
  );
};
