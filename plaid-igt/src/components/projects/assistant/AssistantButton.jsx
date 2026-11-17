import { Link } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { AssistantMark } from '@ui/components/assistant/PlaidMarks.jsx';
import { assistantOffered } from '@ui/components/assistant/assistantGate.js';
import { useOpenAssistant } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { IGT_ASSISTANT, assistantTabPath } from './adapter.js';

/**
 * The Assistant button of a project's Documents and Jobs tabs, the header
 * chip's twin. Where the window has room for the docked panel it opens the
 * panel as the chip does, on whatever conversation the panel holds. Where it
 * has not (the chip is hidden there) it is a link to the project's Assistant
 * tab. Offered on the chip's own rule (`assistantOffered`): only once an
 * assistant is known to be online for the project. `narrowOnly`: drawn only
 * where the window has no room for the panel, where the chip and the edge
 * rail are not drawn, and as the mark alone, named Assistant (a document's
 * header, where the word pushed History onto a second line of the sticky
 * strip at 768 px).
 */
export const AssistantButton = ({ projectId, client, narrowOnly = false, size = 'default' }) => {
  const available = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  const wide = useWideEnoughToDock();
  const open = useOpenAssistant();
  if (!assistantOffered(projectId, available) || (narrowOnly && wide)) return null;
  if (narrowOnly)
    return (
      <Button variant="outline" size={size} className="px-2" asChild>
        <Link to={assistantTabPath(projectId)} aria-label="Assistant" title="Assistant">
          <AssistantMark className="h-4 w-4" />
        </Link>
      </Button>
    );
  const inside = (
    <>
      <AssistantMark className="h-4 w-4" />
      Assistant
    </>
  );
  return wide ? (
    <Button type="button" variant="outline" size={size} className="gap-1.5" onClick={() => open()}>
      {inside}
    </Button>
  ) : (
    <Button variant="outline" size={size} className="gap-1.5" asChild>
      <Link to={assistantTabPath(projectId)}>{inside}</Link>
    </Button>
  );
};
