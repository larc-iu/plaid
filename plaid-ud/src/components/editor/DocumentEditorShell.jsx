import { DocumentEditorShell as Shell } from '@ui/components/shared/DocumentEditorShell.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { useEditorServices } from './hooks/useEditorServices.js';
import { UD_ASSISTANT } from '../assistant/adapter.js';
import { TOKEN_ROLE_WORDS } from '../../domain/restoreSummary.js';

// Parent route of the four document tabs (/edit, /annotate, /export, /details):
// plaid-ui's shell, with what is UD's. The Text Editor's dialog and the
// Annotate toolbar's button share the shell's one services instance, so they
// are the same run rather than two.
const UD_SHELL = {
  // The project and the user ride along so the document writes as this person
  // (provenance convention: see ConlluDocument.writer). The document is read
  // beside the project.
  loadDocument: async ({ client, projectId, documentId, project, user }) => {
    const [projectData, raw] = await Promise.all([project, client.documents.get(documentId, true)]);
    return new ConlluDocument({ raw, client, projectId, project: projectData, user });
  },
  useServices: useEditorServices,
  assistantApp: UD_ASSISTANT.app,
  DocumentTabs,
  roleWords: TOKEN_ROLE_WORDS,
  // A citation names a sentence by the id the annotation editor's ?sent= takes.
  focusParams: (focus) => (focus ? { sent: focus } : null),
  sentenceRef: (sentence, i) => `s${i + 1}`,
  // The Text Editor and Annotate slow down with the document's length.
  wordCount: (doc) => doc?.layerInfo?.wordTokenLayer?.tokens?.length,
};

export const DocumentEditorShell = () => <Shell app={UD_SHELL} />;
