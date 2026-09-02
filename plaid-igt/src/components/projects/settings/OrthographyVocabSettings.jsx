import { OrthographiesSettings } from './OrthographiesSettings.jsx';
import { VocabularySettings } from './VocabularySettings.jsx';

// The two things that hang off a word form rather than describing it: alternate
// spellings of the form itself, and the lexicon entries a form links to.
export const OrthographyVocabSettings = ({ projectId, client }) => (
  <div className="tw flex flex-col gap-8 pt-4 [&>*+*]:border-t [&>*+*]:pt-8">
    <OrthographiesSettings projectId={projectId} client={client} />
    <VocabularySettings projectId={projectId} client={client} />
  </div>
);
