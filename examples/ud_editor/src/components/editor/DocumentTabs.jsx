import { Link, useLocation } from 'react-router-dom';

export const DocumentTabs = ({ projectId, documentId, project, document }) => {
  const location = useLocation();
  const currentPath = location.pathname;
  const isEditMode = currentPath.includes('/edit');
  const isAnnotateMode = currentPath.includes('/annotate');
  const isExportMode = currentPath.includes('/export');
  
  return (
    <div>
      <nav className="flex items-center text-sm text-gray-500 mb-4">
        <Link to="/projects" className="text-blue-600 hover:text-blue-800">Projects</Link>
        <span className="mx-2">/</span>
        <Link to={`/projects/${projectId}/documents`} className="text-blue-600 hover:text-blue-800">
          {project?.name || 'Loading...'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-700">{document?.name || 'Loading...'}</span>
      </nav>

      {/* Document tabs */}
      <div className="mb-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            <Link
              to={`/projects/${projectId}/documents/${documentId}/edit`}
              className={`whitespace-nowrap py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                isEditMode
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Text Editor
            </Link>
            <Link
              to={`/projects/${projectId}/documents/${documentId}/annotate`}
              className={`whitespace-nowrap py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                isAnnotateMode
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Annotate
            </Link>
            <Link
              to={`/projects/${projectId}/documents/${documentId}/export`}
              className={`whitespace-nowrap py-2 px-1 text-sm font-medium border-b-2 transition-colors ${
                isExportMode
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Export
            </Link>
          </nav>
        </div>
      </div>
    </div>
  );
};