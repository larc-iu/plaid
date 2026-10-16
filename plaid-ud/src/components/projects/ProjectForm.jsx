import { NewProjectDialog } from '@ui/components/shared/NewProjectDialog.jsx';
import { createUdProject } from '../../domain/udProjectSetup.js';

// New project: the shared dialog (@ui/components/shared/NewProjectDialog) plus
// what this app builds under one, in its own words. The setup itself is
// `createUdProject`, the same function the e2e fixture calls.
export const ProjectForm = ({ isOpen, onClose, onSuccess }) => (
  <NewProjectDialog
    isOpen={isOpen}
    onClose={onClose}
    onSuccess={onSuccess}
    title="New UD project"
    create={createUdProject}
  >
    <p>Sentences, tokens and words, with lemma, UPOS, XPOS, features and dependencies.</p>
  </NewProjectDialog>
);
