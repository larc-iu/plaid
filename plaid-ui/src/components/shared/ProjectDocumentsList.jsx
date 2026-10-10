import { DocumentTable } from './DocumentTable.jsx';
import { LoadError } from './LoadError.jsx';

/**
 * A project's Documents tab body in every app: the heading, the app's way to
 * make a new document beside it (for a writer), and the table of documents.
 *
 * - `newDocument`: a component drawn beside the heading when `canEdit`, given
 *   `{ projectId, documents }`.
 * - `wordLayerId`, `seedLayerId`: the layers `DocumentTable` counts.
 * - `href(documentId, counts)`: where a row opens.
 * - `error` and `onRetry`: a listing that failed, said above the table.
 */
export const ProjectDocumentsList = ({
  projectId,
  documents,
  client,
  canEdit,
  newDocument: NewDocument,
  wordLayerId,
  seedLayerId,
  href,
  error = '',
  onRetry,
}) => (
  <div>
    <div className="mb-6 flex items-center justify-between">
      <h2 className="text-2xl font-semibold tracking-tight">Documents</h2>
      {canEdit && NewDocument && <NewDocument projectId={projectId} documents={documents} />}
    </div>

    {error && (
      <LoadError onRetry={onRetry} className="mb-4">
        {error}
      </LoadError>
    )}

    <DocumentTable
      documents={documents}
      client={client}
      projectId={projectId}
      wordLayerId={wordLayerId}
      seedLayerId={seedLayerId}
      href={href}
      defaultSort={{ key: 'updated', dir: 'desc' }}
    />
  </div>
);
