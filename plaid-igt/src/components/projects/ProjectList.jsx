import { ProjectListPage } from '@ui/components/shared/ProjectListPage.jsx';
import { getIgtLayerInfo } from '@/domain/layerInfo';
import {
  importRanWhole,
  readIgnoredTokens,
  readImportState,
  wordValueSpec,
} from '@/domain/igtConfig';

// "Words" = the primary token layer (the orthographic word tokens); morphemes
// are sub-word units and shouldn't inflate the word count.
const wordLayerId = (project) => getIgtLayerInfo(project).primaryTokenLayer?.id;
// Nor does a token the ignored-tokens rule excludes (punctuation ud made).
const wordValue = (project) =>
  wordValueSpec(readIgnoredTokens(getIgtLayerInfo(project).primaryTokenLayer?.config));

// A project whose import did not finish opens on that and nothing else.
const note = (project) => {
  const record = readImportState(project.config);
  if (!record) return null;
  return importRanWhole(record) ? 'Import not marked done' : 'Import did not finish';
};

export const ProjectList = () => (
  <ProjectListPage
    wordLayerId={wordLayerId}
    wordValue={wordValue}
    note={note}
    newProject="New project"
    newProjectTo="/projects/new"
  />
);
