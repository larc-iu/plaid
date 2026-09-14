import { Plus } from 'lucide-react';
import { Badge } from '../ui/badge.jsx';
import { Button } from '../ui/button.jsx';
import { AssistantChat } from './AssistantChat.jsx';
import { AssistantMark } from './PlaidMarks.jsx';
import { useConversationParam } from './conversationParam.js';
import {
  AllProjectsSwitch,
  AssistantPicker,
  ConversationRows,
  ExportMenu,
} from './ConversationList.jsx';

// The Assistant tab: the whole screen, laid out like any chat app, with past
// conversations on the left and the active one on the right.
//
// What it adds to the chat: the rail of conversations, the export menu, and
// the room to introduce itself. The conversation it is showing is in the URL
// (`?conversation=<id>`), so a thread can be shared and backed out of.
export const AssistantTab = ({
  projectId,
  projectName,
  client,
  userId,
  canWrite,
  contributor = false,
  adapter,
}) => {
  const [convId, setConvId] = useConversationParam();
  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[32rem] gap-4">
      <AssistantChat
        projectId={projectId}
        client={client}
        userId={userId}
        canWrite={canWrite}
        contributor={contributor}
        adapter={adapter}
        conversationId={convId}
        onConversationId={setConvId}
        renderSidebar={({ listProps, allProjects, setAllProjects, startNew }) => (
          <aside className="flex w-64 shrink-0 flex-col rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">Conversations</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={startNew}
                title="New conversation"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <AllProjectsSwitch
              checked={allProjects}
              onCheckedChange={setAllProjects}
              className="border-b px-3 py-1.5"
            />
            <div className="flex-1 overflow-y-auto p-1.5">
              <ConversationRows {...listProps} />
            </div>
            <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
              Conversations are private to you and saved to your account.
            </p>
          </aside>
        )}
        renderIdentity={({ choice, service }) => (
          <>
            <span className="font-medium">{service.serviceName}</span>
            {choice.model && !service.serviceName?.includes(choice.model) && (
              <Badge variant="secondary">{choice.model}</Badge>
            )}
            {!canWrite && (
              <span className="text-xs text-muted-foreground">
                Read-only access: plans cannot be applied.
              </span>
            )}
          </>
        )}
        renderActions={({ conversation, meta }) =>
          conversation?.display.length > 0 && (
            <ExportMenu
              conv={conversation}
              meta={meta}
              projectId={projectId}
              projectName={projectName}
              adapter={adapter}
            />
          )
        }
        renderEmpty={({ choice, canSend, busy, send }) => (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            {/* No disc around it: the mark is already a rounded square, so a
                grey circle behind it was a container around a container. */}
            <AssistantMark ring className="h-11 w-11" />
            <div className="max-w-md text-sm text-muted-foreground">
              {adapter.intro} Changes come back as a plan to approve.
            </div>
            {/* Which assistant answers is settled here, at the start, and then
                stays put for the rest of the conversation. */}
            {choice.canChoose && (
              <AssistantPicker
                assistants={choice.assistants}
                stranded={choice.stranded}
                value={choice.service?.serviceId}
                onChange={choice.choose}
                disabled={busy}
              />
            )}
            <div className="flex flex-wrap justify-center gap-2">
              {adapter.examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={!canSend}
                  onClick={() => send(ex)}
                  className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
      />
    </div>
  );
};
