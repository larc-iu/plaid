import { useOutletContext } from 'react-router-dom';

// Everything an app's DocumentEditorShell provides to the document tabs, which
// is at least `{ projectId, documentId, doc, project, reload, comments,
// canComment, canDeleteAnyComment, setChromeOffset }` and whatever else that
// app's shell adds. Each shell renders its Outlet only once `doc` and `project`
// are loaded, so a tab may use both without a null check.
//
// It is a hook of its own, here, because the tabs that read it are shared and a
// shell file that exported it as well as its component would trip React Fast
// Refresh's one-export rule.
export const useDocumentEditor = () => useOutletContext();
