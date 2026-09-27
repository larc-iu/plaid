import { DocumentTabStrip } from '@ui/components/shared/DocumentTabStrip.jsx';

// This app's document tabs, as data for the shared strip
// (@ui/components/shared/DocumentTabStrip), which draws them under the
// breadcrumb and the document's name and asks the unsaved-draft guard before
// leaving one. The order is every app's: the work tabs, then Comments, Export,
// Details. The tab row is pinned under the app header, as in plaid-igt, so the
// way across a long document stays in reach. The strip lays out in the
// shell's page box, which runs to the window's edge, so each part takes the
// page's inset itself.
//
// There is no Text Editor tab: the text and the tokens under it are made in
// Plaid IGT or Plaid UD, and this app reads them.
export const DocumentTabs = ({
  projectId,
  documentId,
  project,
  document,
  commentCount = 0,
  disabled = false,
  status = null,
  actions = null,
}) => {
  const base = `/projects/${projectId}/documents/${documentId}`;
  const tabs = [
    { value: 'annotate', label: 'Annotate', to: `${base}/annotate` },
    { value: 'compare', label: 'Compare', to: `${base}/compare` },
    { value: 'comments', label: 'Comments', to: `${base}/comments`, count: commentCount },
    { value: 'export', label: 'Export', to: `${base}/export` },
    { value: 'details', label: 'Details', to: `${base}/details` },
  ];

  return (
    <DocumentTabStrip
      projectId={projectId}
      project={project}
      document={document}
      tabs={tabs}
      disabled={disabled}
      status={status}
      actions={actions}
      sticky
      inset="px-6"
    />
  );
};
