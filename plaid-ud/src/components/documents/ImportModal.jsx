import { useState, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { Modal, Button, FormField, ErrorMessage } from '../ui';

export const ImportModal = ({ projectId, isOpen, onClose, onSuccess }) => {
  const [importText, setImportText] = useState('');
  const [documentName, setDocumentName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [importMethod, setImportMethod] = useState('paste'); // 'paste' or 'upload'
  const fileInputRef = useRef(null);
  const { getClient } = useAuth();

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      setImportText(event.target.result);
      // Extract document name from filename (remove .conllu extension)
      const fileName = file.name.replace(/\.conllu$/i, '');
      if (!documentName) {
        setDocumentName(fileName);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
    };
    reader.readAsText(file);
  };

  const performImport = async () => {
    if (!documentName.trim()) {
      setError('Document name is required');
      return;
    }
    if (!importText.trim()) {
      setError('No content to import');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const client = getClient();
      await ConlluDocument.importFromConllu(client, projectId, documentName, importText);
      setSuccess(true);
      setTimeout(() => { onSuccess(); }, 2000);
    } catch (err) {
      console.error('Import failed:', err);
      setError(`Import failed: ${err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={success ? 'Import Successful!' : 'Import CoNLL-U Document'}
      size="large"
    >
      <div className="p-6 space-y-4">
        {success && (
          <div className="rounded-md bg-green-50 p-4">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-green-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-sm text-green-800">Document imported successfully! Redirecting...</p>
            </div>
          </div>
        )}

        <ErrorMessage message={error} />

        <FormField
          label="Document Name"
          name="documentName"
          value={documentName}
          onChange={(e) => setDocumentName(e.target.value)}
          placeholder="Enter document name"
          required
          disabled={loading}
        />

        <div className="space-y-4">
          <div className="flex gap-4">
            <Button
              type="button"
              onClick={() => setImportMethod('paste')}
              variant={importMethod === 'paste' ? 'primary' : 'secondary'}
              disabled={loading}
            >
              Paste Text
            </Button>
            <Button
              type="button"
              onClick={() => setImportMethod('upload')}
              variant={importMethod === 'upload' ? 'primary' : 'secondary'}
              disabled={loading}
            >
              Upload File
            </Button>
          </div>

          {importMethod === 'paste' ? (
            <FormField
              label="CoNLL-U Text"
              name="conlluText"
              disabled={loading}
            >
              <textarea
                id="conlluText"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="Paste your CoNLL-U formatted text here..."
                rows={15}
                disabled={loading}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </FormField>
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".conllu,.txt"
                onChange={handleFileUpload}
                className="hidden"
                disabled={loading}
              />
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                variant="secondary"
              >
                Choose File...
              </Button>
              {importText && (
                <div className="mt-4 p-4 bg-gray-50 rounded-md">
                  <p className="text-sm text-gray-600 mb-2">File loaded. Preview:</p>
                  <pre className="text-xs font-mono text-gray-700 overflow-x-auto max-h-40 overflow-y-auto">
                    {importText.substring(0, 500)}
                    {importText.length > 500 && '...'}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="p-6 border-t border-gray-200 bg-gray-50">
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={performImport}
            disabled={loading || !importText.trim() || !documentName.trim()}
            isLoading={loading}
          >
            {loading ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
