import { DocumentEditorShell as Shell } from '@ui/components/shared/DocumentEditorShell.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useEditorServices } from './hooks/useEditorServices.js';
import { UD_ASSISTANT } from '../assistant/adapter.js';
import { TOKEN_ROLE_WORDS } from '../../domain/restoreSummary.js';
import { TASKS } from '@larc-iu/plaid-client';
import { parseNotice } from '../../domain/parseNotice.js';

// Parent route of the document tabs (/edit, /annotate, /comments, /export,
// /details): plaid-ui's shell, with what is UD's. The Text Editor's dialog and
// the Annotate toolbar's button share the shell's one services instance, so
// they are the same run rather than two.
const UD_SHELL = {
  // The project and the user ride along so the document writes as this person
  // (provenance convention: see ConlluDocument.writer). The document is read
  // beside the project.
  loadDocument: async ({ client, projectId, documentId, project, user }) => {
    const [projectData, raw] = await Promise.all([project, client.documents.get(documentId, true)]);
    return new ConlluDocument({ raw, client, projectId, project: projectData, user });
  },
  useServices: useEditorServices,
  // A Parse rejoined after a reload words its counts as the Parse spot does.
  runNotices: { [TASKS.PARSE]: parseNotice },
  assistantApp: UD_ASSISTANT.app,
  documentPath: (projectId, documentId) => `/projects/${projectId}/documents/${documentId}`,
  // The order is every app's: the work tabs, then Comments, Export, Details.
  tabs: {
    list: [
      { value: 'edit', label: 'Text Editor' },
      { value: 'annotate', label: 'Annotate' },
      { value: 'comments', label: 'Comments' },
      { value: 'export', label: 'Export' },
      { value: 'details', label: 'Details' },
    ],
    editor: 'annotate',
    past: ['annotate', 'export', 'details'],
    long: ['annotate', 'edit'],
  },
  roleWords: TOKEN_ROLE_WORDS,
  // A citation names a sentence by the id the annotation editor's ?sent= takes.
  focusParams: (focus) => (focus ? { sent: focus } : null),
  sentenceRef: (sentence, i) => `s${i + 1}`,
  // The Text Editor and Annotate slow down with the document's length.
  wordCount: (doc) => doc?.layerInfo?.wordTokenLayer?.tokens?.length,
};

export const DocumentEditorShell = () => <Shell app={UD_SHELL} />;
