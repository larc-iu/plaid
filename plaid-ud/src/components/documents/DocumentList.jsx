import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DocumentForm } from './DocumentForm';
import { ProjectTabs } from '../projects/ProjectTabs.jsx';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { adoptSubstrate } from '../../domain/udProjectSetup.js';
import { Button } from '@ui/components/ui/button';
import { ProjectDocumentsPage } from '@ui/components/shared/ProjectDocumentsPage.jsx';

// UD's layers are the same in every project, so setting one up is one button
// (see `adoptSubstrate`).
const SETUP = {
  app: 'UD',
  note: "UD's layers are added beside what is already here. The text and the tokens are left as they are.",
  adopt: (client, project) => adoptSubstrate(client, project),
};

// UD counts its words (the morpheme layer), and a document with no words yet
// counts its tokens.
const tableLayers = (info) => ({
  wordLayerId: info.morphemeTokenLayer?.id,
  seedLayerId: info.wordTokenLayer?.id,
});

// A row links to the Annotate tab by default, but a document with no tokens
// yet has nothing to annotate (the tab would just say "tokenize first"), so it
// points at the Text Editor. Only once word counts have loaded and confirm
// zero tokens: while they are still loading the default stays, so a tokenized
// document clicked early is not mis-routed.
const rowHref = (projectId, documentId, { wordCount, hasWordLayer, wordsLoading }) => {
  const knownEmpty = hasWordLayer && !wordsLoading && (wordCount ?? 0) === 0;
  return `/projects/${projectId}/documents/${documentId}/${knownEmpty ? 'edit' : 'annotate'}`;
};

// The list is handed to the form so a create whose answer was lost can find
// the document it made among the ones that were not there before.
const NewDocument = ({ projectId, documents }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New document
      </Button>
      <DocumentForm
        projectId={projectId}
        documents={documents}
        isOpen={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
};

export const DocumentList = () => (
  <ProjectDocumentsPage
    tabs={ProjectTabs}
    layerInfo={getUdLayerInfo}
    setup={SETUP}
    tableLayers={tableLayers}
    rowHref={rowHref}
    newDocument={NewDocument}
  />
);
