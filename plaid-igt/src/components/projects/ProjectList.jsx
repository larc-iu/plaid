import { ProjectListPage } from '@ui/components/shared/ProjectListPage.jsx';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import { readIgnoredTokens, wordValueSpec } from '@/domain/igtConfig';

// "Words" = the primary token layer (the orthographic word tokens); morphemes
// are sub-word units and shouldn't inflate the word count.
const wordLayerId = (project) => getIgtLayerInfo(project).primaryTokenLayer?.id;
// Nor does a token the ignored-tokens rule excludes (punctuation ud made).
const wordValue = (project) =>
  wordValueSpec(readIgnoredTokens(getIgtLayerInfo(project).primaryTokenLayer?.config));

export const ProjectList = () => (
  <ProjectListPage
    wordLayerId={wordLayerId}
    wordValue={wordValue}
    newProject="New project"
    newProjectTo="/projects/new"
  />
);
