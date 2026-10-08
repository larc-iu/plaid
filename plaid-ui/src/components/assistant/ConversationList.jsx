import { useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { timeAgo } from '../../lib/formatTime.js';
import {
  MessageSquare,
  Download,
  Copy,
  FileDown,
  FileText,
  FolderOpen,
  Globe,
  History,
  Trash2,
} from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Loading } from '../shared/Loading.jsx';
import { Switch } from '../ui/switch.jsx';
import { AuthContext } from '../../contexts/useAuth.js';
import { appName } from '../../lib/uiConfig.js';
import { conversationToHtml } from './exportHtml.js';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select.jsx';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu.jsx';
import { cn } from '../../lib/utils.js';
import { notifySuccess, notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { conversationToMarkdown, markdownFilename } from './exportMarkdown.js';
import { followable, jobFor } from './jobs.js';
import { runByLine } from './useAssistantAvailable.js';
import { useConfirm } from '../shared/ConfirmProvider.jsx';

// The conversation rail: one row per conversation, the assistant picker, and
// the export menu.
// One sidebar entry: the title, when it was last written, which model, and
// whether work was left unfinished.
// A conversation started from a document says so: the same list holds those
// and the ones started from the tab, and which document a thread is about is
// the first thing that tells them apart.
// `elsewhere` is the name of the project a row belongs to when that is not the
// one on screen, for a list widened past this project.
const ConversationRow = ({ m, opening, elsewhere = null }) => {
  // Where the conversation began. The field name is the kind, so a vocabulary
  // thread reads its own: only the document was named here, and every thread
  // started beside a vocabulary showed no subject at all.
  const began = m.about?.documentName || m.about?.lexiconName;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('truncate', m.draft && 'italic')}>{m.title || 'Untitled'}</span>
      </div>
      <div className="pl-5 text-[11px] text-muted-foreground">
        {m.draft
          ? 'Nothing sent yet'
          : (opening === m.id ? 'Opening…' : timeAgo(m.updatedAt)) +
            (m.model ? ` · ${m.model.split('/').pop()}` : '') +
            (followable(m.pending) && !jobFor(m.id) ? ' · unfinished' : '')}
      </div>
      {elsewhere && (
        <div className="flex items-center gap-1 pl-5 text-[11px] text-muted-foreground">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate" title={elsewhere}>
            {elsewhere}
          </span>
        </div>
      )}
      {began && (
        <div className="flex items-center gap-1 pl-5 text-[11px] text-muted-foreground">
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate" title={began}>
            {began}
          </span>
        </div>
      )}
    </>
  );
};

// Whether the list reaches past the project on screen. A conversation belongs
// to the project it was started in, and a reader who remembers discussing
// something does not always remember where.
export const AllProjectsSwitch = ({ checked, onCheckedChange, className }) => (
  <label className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', className)}>
    <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label="All projects" />
    All projects
  </label>
);

// The rows, as the tab's rail and the docked panel's history both draw them.
//
// A row from ANOTHER project is a link wherever it appears: only that
// project's own assistant can answer in that thread, so choosing it is a
// navigation. A row from this project is a link in the tab, where the
// conversation is in the URL and so shareable. In the panel, where the URL
// belongs to the screen behind it, a plain click opens the row in the panel
// (`onPick`), and the row is still a link to the conversation on the Assistant
// screen, for a new tab.
//
// `onDelete` is handed the WHOLE row, because a row from another project is
// deleted under that project's keys and only the row knows which. It is asked
// first, naming the conversation: a delete takes its plans' record with it and
// cannot be undone, and the icon sits beside the row a reader means to open.
export const ConversationRows = ({
  rows,
  activeId,
  projectId,
  projectNames,
  opening,
  loading,
  hrefFor,
  onPick = null,
  onDelete,
}) => {
  const confirm = useConfirm();
  const askDelete = async (m) => {
    const ok = await confirm({
      title: `Delete “${m.title || 'New conversation'}”?`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) onDelete(m);
  };
  if (loading && !rows.length) return <Loading className="px-2 py-3 text-xs" />;
  if (!rows.length)
    return <div className="px-2 py-3 text-xs text-muted-foreground">No conversations yet.</div>;
  return rows.map((m) => {
    const other = m.projectId && m.projectId !== projectId ? m.projectId : null;
    const row = (
      <ConversationRow
        m={m}
        opening={opening}
        elsewhere={other ? projectNames.get(other) || 'Another project' : null}
      />
    );
    return (
      <div
        key={m.id}
        className={cn(
          'group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
          activeId === m.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        )}
      >
        {m.draft ? (
          <div className="min-w-0 flex-1 text-left">{row}</div>
        ) : onPick && !other ? (
          // Still a link to the conversation on the Assistant screen, so it
          // opens in a new tab like any other. A plain click opens it here.
          <Link
            to={hrefFor(m)}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onPick(m.id);
            }}
            className="min-w-0 flex-1 text-left"
          >
            {row}
          </Link>
        ) : (
          <Link to={hrefFor(m)} className="min-w-0 flex-1 text-left">
            {row}
          </Link>
        )}
        {!m.draft && (
          <button
            type="button"
            onClick={() => askDelete(m)}
            title="Delete conversation"
            className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  });
};

// Past conversations in the docked panel. The panel is a third of a screen
// wide at most, so the list hangs off its header rather than standing beside
// the chat, and closes as soon as a thread is chosen. The tab keeps the rail:
// it has the room, and reading an old conversation is what it is for.
export const ConversationHistory = ({ allProjects, onAllProjects, onPick, ...list }) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" title="Past conversations">
          <History className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">Conversations</span>
          <AllProjectsSwitch checked={allProjects} onCheckedChange={onAllProjects} />
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1.5">
          <ConversationRows
            {...list}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
};

// Which assistant a new conversation talks to. Shown only where there is a
// choice to make: more than one online, and a conversation not yet bound to
// one of them.
// `compact` is the docked panel's: it goes where the model name was, in a
// header a third of a screen wide, so it drops its border and its minimum
// width and names each assistant by its MODEL, which is what the reader was
// already looking at there.
export const AssistantPicker = ({ assistants, value, onChange, disabled, compact = false }) => (
  <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger
      className={
        compact
          ? 'h-7 w-auto min-w-0 gap-1 border-0 px-1.5 text-muted-foreground shadow-none'
          : 'h-8 w-auto min-w-48 gap-2'
      }
      aria-label="Assistant"
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {assistants.map((s) => (
        <SelectItem key={s.serviceId} value={s.serviceId} hint={runByLine(s) || undefined}>
          {compact ? s.extras?.model || s.serviceName : s.serviceName}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

// ---- export -----------------------------------------------------------------
// The conversation as Markdown, downloaded as a file or copied, or as a web
// page (exportHtml.js).

const save = (blob, name) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// `client` reads which projects the exporter can open and, with `owner` (the
// conversation's owner, whose store holds the files its replies made, under
// `app`), those files. `appLabel` names the app on the page, the app's own
// name by default.
export const ExportMenu = ({
  conv,
  meta,
  projectId,
  projectName,
  adapter,
  client,
  owner,
  app = adapter.app,
  appLabel = null,
}) => {
  const exporter = useContext(AuthContext)?.user;
  const build = () =>
    conversationToMarkdown(conv, meta, {
      origin: `${window.location.origin}${window.location.pathname}`,
      projectId,
      projectName,
      adapter,
    });
  const download = () =>
    save(new Blob([build()], { type: 'text/markdown;charset=utf-8' }), markdownFilename(meta));
  const downloadPage = async () => {
    try {
      const projects = await client.projects.list();
      const html = await conversationToHtml(conv, meta, {
        projectId,
        projectName,
        adapter,
        store: { client, userId: owner, app, projectId },
        readable: new Set((projects || []).map((p) => p.id)),
        exporter: exporter?.displayName || exporter?.id || null,
        appLabel: appLabel || appName(),
        sheets: document.styleSheets,
      });
      save(new Blob([html], { type: 'text/html;charset=utf-8' }), markdownFilename(meta, 'html'));
    } catch (e) {
      notifyError(humanizeError(e, 'Failed to export the conversation.'), 'Not exported');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(build());
      notifySuccess('The conversation was copied as Markdown.', 'Copied');
    } catch (e) {
      notifyError(humanizeError(e, 'Failed to copy to the clipboard.'), 'Not copied');
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" title="Export this conversation">
          <Download className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={download}>
          <FileDown className="mr-2 h-4 w-4" /> Download as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={downloadPage}>
          <Globe className="mr-2 h-4 w-4" /> Download as web page
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copy}>
          <Copy className="mr-2 h-4 w-4" /> Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ---- sentence citations -----------------------------------------------------
// The model cites evidence as `<cite doc="Text 1" ref="s3"/>`; the service
// resolves each to interlinear data (see citations.js and citations.py). A
// citation alone on a line becomes an example card in place; one inside a
// sentence becomes a link, and its card is listed under the reply.
