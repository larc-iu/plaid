import { DocumentEditorShell as Shell } from '@ui/components/shared/DocumentEditorShell.jsx';
import { UMR_ASSISTANT } from '../assistant/adapter.js';
import { UmrDocument } from '../../domain/UmrDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { useUmrServices } from './hooks/useUmrServices.js';
import { TOKEN_ROLE_WORDS, UMR_LAYER_WORDS } from '../../domain/restoreSummary.js';

// Parent route of a document's tabs: plaid-ui's shell, with what is UMR's. The
// one integration spot, Draft, is the shell's one services instance, so a run
// started on the Annotate tab keeps its lock, its banner and its progress on
// another tab.
const UMR_SHELL = {
  loadDocument: async ({ client, projectId, documentId, project, user }) =>
    UmrDocument.load({ client, documentId, projectId, project: await project, user }),
  useServices: useUmrServices,
  assistantApp: UMR_ASSISTANT.app,
  DocumentTabs,
  tabs: { editor: 'annotate', past: ['annotate', 'export', 'details'] },
  roleWords: TOKEN_ROLE_WORDS,
  layerWords: UMR_LAYER_WORDS,
  // A citation names a sentence by its number and may name a node (`var`),
  // which the annotation editor's ?sent= and ?var= take.
  focusParams: (focus) =>
    focus?.sentence ? { sent: String(focus.sentence), var: focus.var || null } : null,
  // The number the sentence goes by, the file's own in a document numbered
  // by its file, as the assistant reads it.
  sentenceRef: (sentence) => `s${sentence.number ?? sentence.index}`,
};

export const DocumentEditorShell = () => <Shell app={UMR_SHELL} />;
