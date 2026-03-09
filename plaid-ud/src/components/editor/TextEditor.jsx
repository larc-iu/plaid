import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentStore } from '../../model/DocumentStore.js';
import { textEditorView } from '../../views/textEditorView.js';
import { DocumentTabs } from './DocumentTabs.jsx';

export const TextEditor = () => {
  const { projectId, documentId } = useParams();
  const { getClient } = useAuth();
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const storeRef = useRef(null);
  const [project, setProject] = useState(null);
  const [docData, setDocData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fetch data
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setLoading(true);
        setDocData(null);
        const client = getClient();
        if (!client) { window.location.href = '/login'; return; }

        const [proj, doc] = await Promise.all([
          client.projects.get(projectId),
          client.documents.get(documentId, true),
        ]);

        if (cancelled) return;

        setProject(proj);
        setDocData(doc);
        setError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { window.location.href = '/login'; return; }
        setError('Failed to load document: ' + (err.message || 'Unknown error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [projectId, documentId]);

  // Mount plain JS view once data + container are ready
  useEffect(() => {
    if (!docData || !containerRef.current) return;

    const client = getClient();
    const store = new DocumentStore();
    storeRef.current = store;
    store.replaceDocument(docData, client);

    containerRef.current.innerHTML = '';
    const view = textEditorView(containerRef.current, { client, store });
    viewRef.current = view;

    return () => {
      if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; }
      store.clear();
      storeRef.current = null;
    };
  }, [docData]);

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">{error}</p>
      </div>
    );
  }

  return (
    <div>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={docData}
      />
      <div ref={containerRef} />
    </div>
  );
};
