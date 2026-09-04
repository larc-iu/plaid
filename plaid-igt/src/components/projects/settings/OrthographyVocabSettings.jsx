import { OrthographiesSettings } from './OrthographiesSettings.jsx';
import { VocabularySettings } from './VocabularySettings.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';

// How the text is written, and the vocabulary its words link to: alternate
// spellings of a form, the characters used to type them, and the lexicon
// entries behind them.
export const OrthographyVocabSettings = ({ project, projectId, client, onProjectUpdate }) => (
  <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
    <OrthographiesSettings projectId={projectId} client={client} />
    <ComposeSettings
      project={project}
      projectId={projectId}
      client={client}
      onProjectUpdate={onProjectUpdate}
    />
    <VocabularySettings projectId={projectId} client={client} />
  </div>
);
