import { OrthographiesSettings } from './OrthographiesSettings.jsx';
import { VocabularySettings } from './VocabularySettings.jsx';
import { ComposeSettings } from './ComposeSettings.jsx';
import { Card } from '@ui/components/ui/card';

// How the text is written, and the vocabulary its words link to: alternate
// spellings of a form, the characters used to type them, and the lexicon
// entries behind them. Each part in a card of its own, as every app's settings
// are laid out; the settings layout spaces them.
export const OrthographyVocabSettings = ({ project, projectId, client, onProjectUpdate }) => (
  <>
    <Card className="p-6">
      <OrthographiesSettings projectId={projectId} client={client} />
    </Card>
    <Card className="p-6">
      <VocabularySettings projectId={projectId} client={client} />
    </Card>
    <Card className="p-6">
      <ComposeSettings
        project={project}
        projectId={projectId}
        client={client}
        onProjectUpdate={onProjectUpdate}
      />
    </Card>
  </>
);
