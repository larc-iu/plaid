import { ProjectListPage } from '@ui/components/shared/ProjectListPage.jsx';
import { ProjectForm } from './ProjectForm';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';

// "Words" = the morpheme layer: in the sentence>word>morpheme UD model the
// morpheme layer holds the syntactic words (the CoNLL-U token rows where
// annotations live), which is what a word count should mean.
const wordLayerId = (project) => getUdLayerInfo(project).morphemeTokenLayer?.id;

export const ProjectList = () => (
  <ProjectListPage wordLayerId={wordLayerId} newProject="New UD project" form={ProjectForm} />
);
