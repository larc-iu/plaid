// The recordings nobody claimed.
//
// What WILL be uploaded is listed per document in ElanDocumentsPanel, beside
// the document it belongs to. What is left over is a different fact and an
// easy mistake to make: a file whose name matches no .eaf in the batch is
// silently not uploaded, and the usual cause is picking the recording for a
// file that was left out.

import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel } from '../ImportPanels.jsx';

export const ElanMediaPanel = ({ media, editable, onRemove }) => {
  if (!media.unmatched.length) return null;
  return (
    <Panel
      tone="warn"
      icon={AlertTriangle}
      title={`${media.unmatched.length} recording${media.unmatched.length === 1 ? '' : 's'} match no .eaf in this batch`}
    >
      <p className="mt-1 text-xs">
        A recording is matched to the file that names it, or to one with the same name. These are
        not uploaded.
      </p>
      <ul className="mt-2 flex flex-col gap-0.5 text-xs">
        {media.unmatched.map((f) => (
          <li key={f.name} className="flex items-center gap-1">
            <span className="font-mono">{f.name}</span>
            {editable && onRemove && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemove(f)}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
};
