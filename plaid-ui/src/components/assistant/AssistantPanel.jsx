import { useState } from 'react';
import { Maximize2, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.jsx';
import { AssistantChat } from './AssistantChat.jsx';
import { AssistantPicker, ConversationHistory } from './ConversationList.jsx';

// The assistant in the shell's dock: the same chat, a third of a screen wide,
// beside whatever the reader is working on.
//
// What it adds to the chat: a header that names which assistant answers and
// offers the choice in the same place, past conversations as a popover rather
// than a rail, a way to move the thread to the full tab, and a way to put the
// panel away. Which conversation is open is state and not a URL: the panel
// lives on the screen's own route, and that URL is the document's.
export const AssistantPanel = ({
  projectId,
  projectName,
  client,
  userId,
  canWrite,
  contributor = false,
  adapter,
  subject = null,
  focus = null,
  onClearFocus,
  onHide,
}) => {
  const [convId, setConvId] = useState(null);
  const subjectName = subject?.kind ? subject?.name || null : null;
  return (
    <div className="flex h-full min-h-0">
      <AssistantChat
        compact
        projectId={projectId}
        client={client}
        userId={userId}
        canWrite={canWrite}
        contributor={contributor}
        adapter={adapter}
        subject={subject}
        focus={focus}
        onClearFocus={onClearFocus}
        onHide={onHide}
        conversationId={convId}
        onConversationId={(id) => setConvId(id)}
        resumeNewest
        toastOnApply={false}
        renderIdentity={({ choice, busy }) =>
          // Which assistant answers is settled at the start of a conversation
          // and then stays put, so the panel offers the choice exactly where it
          // shows the answer: the model's name IS the picker while the thread
          // is new, and plain text once it is not.
          choice.canChoose ? (
            <AssistantPicker
              assistants={choice.assistants}
              stranded={choice.stranded}
              value={choice.service.serviceId}
              onChange={choice.choose}
              disabled={busy}
              compact
            />
          ) : (
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={choice.service.serviceName}
            >
              {choice.model || choice.service.serviceName}
            </span>
          )
        }
        renderActions={({ listProps, allProjects, setAllProjects, conversation, startNew }) => (
          <>
            <ConversationHistory
              {...listProps}
              allProjects={allProjects}
              onAllProjects={setAllProjects}
              onPick={(id) => setConvId(id)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={startNew}
              title="New conversation"
            >
              <Plus className="h-4 w-4" />
            </Button>
            {!conversation?.draft && (
              // The panel is not offered on the Assistant screen
              // (assistantGate), so this moves the thread there rather than
              // drawing it twice.
              <Link
                to={adapter.convHref(projectId, conversation.id)}
                title="Open in Assistant"
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Maximize2 className="h-4 w-4" />
              </Link>
            )}
          </>
        )}
        renderEmpty={() => (
          <div className="mt-4 flex flex-col items-center gap-4 text-center">
            <div className="max-w-md text-sm text-muted-foreground">
              {/* The panel reaches screens that are about no one thing (the
                  project's own tabs, a vocabulary list), where the old fallback
                  to "this document" named something that was not on screen. */}
              {subjectName ? (
                <>Ask about {subjectName}, or about the rest of the project.</>
              ) : (
                <>Ask about {projectName || 'this project'}.</>
              )}
            </div>
          </div>
        )}
      />
    </div>
  );
};
