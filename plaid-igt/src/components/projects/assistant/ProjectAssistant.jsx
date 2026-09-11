import { ProjectAssistant as SharedAssistant } from '@ui/components/assistant/ProjectAssistant.jsx';
import { IGT_ASSISTANT } from './adapter.js';

// The Assistant tab. The screen is shared with plaid-ud
// (plaid-ui/src/components/assistant/); everything here that is IGT's -- how a
// place in a document is addressed and linked, and how a cited sentence is
// drawn -- is in adapter.js.
export const ProjectAssistant = (props) => <SharedAssistant {...props} adapter={IGT_ASSISTANT} />;
