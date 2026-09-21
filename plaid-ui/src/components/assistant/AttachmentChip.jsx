import { FileText, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { fileSize } from './attachments.js';

// One attached file, in the composer before it is sent and on the message
// after. Name and size, which is all the browser honestly knows: what SHAPE a
// file is in (a table of so many rows, under these columns) is the service's
// answer, made by the same parser that will read it, and it is said in the
// reply rather than guessed at twice.
export const AttachmentChip = ({ file, onRemove = null, className = '' }) => (
  <span
    className={cn(
      'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 py-1 pl-2.5 text-xs',
      onRemove ? 'pr-1' : 'pr-2.5',
      className,
    )}
  >
    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
    <span className="truncate font-medium">{file.name}</span>
    <span className="shrink-0 text-muted-foreground">{fileSize(file.bytes)}</span>
    {onRemove && (
      <button
        type="button"
        onClick={() => onRemove(file.id)}
        title="Remove"
        aria-label={`Remove ${file.name}`}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    )}
  </span>
);
