import { ProjectAssistant as SharedAssistant } from '@ui/components/assistant/ProjectAssistant.jsx';
import { UD_ASSISTANT } from './adapter.js';

// The Assistant screen. It is shared with plaid-igt
// (plaid-ui/src/components/assistant/); everything here that is UD's -- how a
// place in a document is addressed and linked, and how a cited sentence is
// drawn -- is in adapter.js.
export const ProjectAssistant = (props) => <SharedAssistant {...props} adapter={UD_ASSISTANT} />;
