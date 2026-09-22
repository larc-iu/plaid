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
    <p>Layers created with the project:</p>
    <ul className="mt-2 list-disc pl-5">
      <li>Text layer</li>
      <li>Token layers: Sentences &rarr; Words</li>
      <li>UMR nodes, concepts, relations and document graph</li>
    </ul>
    <p className="mt-2">Documents come from .umr import. Text is edited in Plaid IGT or UD.</p>
  </NewProjectDialog>
);
