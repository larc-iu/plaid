import { useOutletContext } from 'react-router-dom';

// Everything DocumentEditorShell provides to the three document-editor tabs:
// `{ projectId, documentId, doc, project, reload, setChromeOffset }`. The shell
// only renders its Outlet once `doc` and `project` are loaded, so tabs can use
// both without a null check.
//
// Lives in its own module so the shell file exports components only (React Fast
// Refresh warns on a mixed module).
export const useDocumentEditor = () => useOutletContext();
