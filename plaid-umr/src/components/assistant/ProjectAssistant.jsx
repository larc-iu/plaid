import { AssistantTab } from '@ui/components/assistant/AssistantTab.jsx';
import { UMR_ASSISTANT } from './adapter.js';

// The Assistant screen. It is shared with plaid-ud and plaid-igt
// (plaid-ui/src/components/assistant/); everything here that is UMR's -- how a
// place in a document is addressed and linked, and how a cited sentence is
// drawn -- is in adapter.js.
export const ProjectAssistant = (props) => <AssistantTab {...props} adapter={UMR_ASSISTANT} />;
