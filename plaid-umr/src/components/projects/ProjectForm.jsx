import { NewProjectDialog } from '@ui/components/shared/NewProjectDialog.jsx';
import { createUmrProject } from '../../domain/umrProjectSetup.js';

// New project: the shared dialog (@ui/components/shared/NewProjectDialog) plus
// what this app builds under one, in its own words. The setup itself is
// `createUmrProject`, the same function the e2e fixture calls.
export const ProjectForm = ({ isOpen, onClose, onSuccess }) => (
  <NewProjectDialog
    isOpen={isOpen}
    onClose={onClose}
    onSuccess={onSuccess}
    title="New UMR project"
    create={createUmrProject}
  >
    <p>Sentence and document graphs over each text&rsquo;s words.</p>
  </NewProjectDialog>
);
