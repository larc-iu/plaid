import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';

export const ExportEditor = () => {
  const { projectId, documentId } = useParams();
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const { getClient } = useAuth();

  useConlluDocument(doc);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const client = getClient();
      if (!client) { window.location.href = '/login'; return; }
      try {
        setLoading(true);
        const [projectData, next] = await Promise.all([
          client.projects.get(projectId),
          ConlluDocument.load(client, projectId, documentId)
        ]);
        if (cancelled) return;
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) { window.location.href = '/login'; return; }
        setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
        console.error('Error fetching data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  const conlluContent = doc ? doc.toConllu() : '';

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(conlluContent);
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([conlluContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `${doc?.name || 'document'}.conllu`;
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="text-center text-gray-600 py-8">Loading document...</div>;
  }

  if (!doc || !project) {
    return (
      <div className="rounded-md bg-red-50 p-4">
        <p className="text-sm text-red-800">{loadError || 'Document or project not found'}</p>
      </div>
    );
  }

  return (
    <div>
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={doc.raw}
      />

      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">CoNLL-U Export</h3>

        {loadError && (
          <div className="rounded-md bg-red-50 p-4 mb-4">
            <p className="text-sm text-red-800">{loadError}</p>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          <button
            onClick={handleCopyToClipboard}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            {copiedToClipboard ? 'Copied!' : 'Copy to Clipboard'}
          </button>

          <button
            onClick={handleDownload}
            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
            Download .conllu
          </button>
        </div>

        <div className="border border-gray-300 rounded-md">
          <textarea
            className="w-full p-4 font-mono text-sm bg-gray-50 rounded-md resize-y"
            value={conlluContent}
            readOnly
            rows={20}
            style={{ minHeight: '400px' }}
          />
        </div>
      </div>
    </div>
  );
};
