import { createContext, useContext } from 'react';

// Set while a conversation is drawn for the web page export (exportHtml.js):
// the page is read with no script, so what the chat folds behind a button is
// folded behind a <details> instead, a plan shows every change, and a file the
// reply made may be shown in full (`fileBody(file)`, a node or null).
// Null everywhere else.
export const ExportContext = createContext(null);

export const useExport = () => useContext(ExportContext);
