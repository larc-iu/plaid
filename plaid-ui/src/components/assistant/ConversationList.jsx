import { timeAgo } from '../../utils/formatTime.js';
import { MessageSquare, Download, Copy, FileDown, FileText } from 'lucide-react';
import { Button } from '../ui/button.jsx';
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
import { jobFor } from './jobs.js';

// The conversation rail: one row per conversation, the assistant picker, and
// the export menu.
// One sidebar entry: the title, when it was last written, which model, and
// whether work was left unfinished.
// A conversation started from a document says so: the same list holds those
// and the ones started from the tab, and which document a thread is about is
// the first thing that tells them apart.
export const ConversationRow = ({ m, opening }) => (
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
          (m.pending && !jobFor(m.id) ? ' · unfinished' : '')}
    </div>
    {m.about?.documentName && (
      <div className="flex items-center gap-1 pl-5 text-[11px] text-muted-foreground">
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate" title={m.about.documentName}>
          {m.about.documentName}
        </span>
      </div>
    )}
  </>
);

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
        <SelectItem key={s.serviceId} value={s.serviceId}>
          {compact ? s.extras?.model || s.serviceName : s.serviceName}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

// ---- export -----------------------------------------------------------------
// The conversation as Markdown: downloaded as a file, or copied.

export const ExportMenu = ({ conv, meta, projectId, projectName, adapter }) => {
  const build = () =>
    conversationToMarkdown(conv, meta, {
      origin: `${window.location.origin}${window.location.pathname}`,
      projectId,
      projectName,
      adapter,
    });
  const download = () => {
    const blob = new Blob([build()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = markdownFilename(meta);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(build());
      notifySuccess('The conversation was copied as Markdown.', 'Copied');
    } catch (e) {
      notifyError(humanizeError(e, 'Could not copy to the clipboard.'), 'Not copied');
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
