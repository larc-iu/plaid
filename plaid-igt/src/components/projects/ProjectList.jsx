import { ProjectListPage } from '@ui/components/shared/ProjectListPage.jsx';
import { getIgtLayerInfo } from '@/domain/layerInfo';

// "Words" = the primary token layer (the orthographic word tokens); morphemes
// are sub-word units and shouldn't inflate the word count.
const wordLayerId = (project) => getIgtLayerInfo(project).primaryTokenLayer?.id;

export const ProjectList = () => (
  <ProjectListPage
    wordLayerId={wordLayerId}
    newProject="New project"
    newProjectTo="/projects/new"
  />
);
