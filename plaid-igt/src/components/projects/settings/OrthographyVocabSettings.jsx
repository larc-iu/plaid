import { OrthographiesSettings } from './OrthographiesSettings.jsx';
import { VocabularySettings } from './VocabularySettings.jsx';

// How the text is written, and the vocabulary its words link to: alternate
// spellings of a form, and the lexicon entries behind it.
export const OrthographyVocabSettings = ({ projectId, client }) => (
  <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
    <OrthographiesSettings projectId={projectId} client={client} />
    <VocabularySettings projectId={projectId} client={client} />
  </div>
);
