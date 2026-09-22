import { DocumentTabStrip } from '@ui/components/shared/DocumentTabStrip.jsx';

// This app's document tabs, as data for the shared strip
// (@ui/components/shared/DocumentTabStrip), which draws them with the
// breadcrumb and asks the unsaved-draft guard before leaving one.
//
// There is no Text Editor tab: the text and the tokens under it are made in
// Plaid IGT or Plaid UD, and this app reads them.
export const DocumentTabs = ({ projectId, documentId, project, document, disabled = false }) => {
  const base = `/projects/${projectId}/documents/${documentId}`;
  const tabs = [
    { value: 'annotate', label: 'Annotate', to: `${base}/annotate` },
    { value: 'details', label: 'Details', to: `${base}/details` },
    { value: 'comments', label: 'Comments', to: `${base}/comments` },
    { value: 'compare', label: 'Compare', to: `${base}/compare` },
    { value: 'export', label: 'Export', to: `${base}/export` },
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
