import { DocumentTabStrip } from '@ui/components/shared/DocumentTabStrip.jsx';

// This app's document tabs, as data for the shared strip
// (@ui/components/shared/DocumentTabStrip), which draws them with the
// breadcrumb and asks the unsaved-draft guard before leaving one.
export const DocumentTabs = ({ projectId, documentId, project, document, disabled = false }) => {
  const base = `/projects/${projectId}/documents/${documentId}`;
  const tabs = [
    { value: 'edit', label: 'Text Editor', to: `${base}/edit` },
    { value: 'annotate', label: 'Annotate', to: `${base}/annotate` },
    { value: 'export', label: 'Export', to: `${base}/export` },
    { value: 'comments', label: 'Comments', to: `${base}/comments` },
    { value: 'details', label: 'Details', to: `${base}/details` },
  ];

  return (
    <DocumentTabStrip
      projectId={projectId}
      project={project}
      document={document}
      tabs={tabs}
      disabled={disabled}
    />
  );
};
