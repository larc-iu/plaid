// The recordings a run will upload, named and totalled before it starts.
//
// A .eaf names its recording but does not carry it, so the files are picked
// alongside and paired by that name (matchMediaFiles). Uploading is the slowest
// part of an ELAN import by a wide margin, so what is about to go up, and how
// much of it, is worth saying before the button is pressed rather than after.

import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/utils/formatBytes';
import { Panel } from '../ImportPanels.jsx';

export const ElanMediaPanel = ({ media, files, editable, onRemove }) => {
  const matched = [...media.byFile.entries()];
  if (!matched.length && !media.unmatched.length) return null;
  const total = matched.reduce((n, [, f]) => n + (f.size || 0), 0);
  const nameOf = (eafFile) => files.find((f) => f.fileName === eafFile)?.documentName ?? eafFile;
  return (
    <Panel
      tone={media.unmatched.length ? 'warn' : 'muted'}
      icon={media.unmatched.length ? AlertTriangle : null}
      title={`Recordings: ${matched.length} of ${files.length} document${files.length === 1 ? '' : 's'}${total ? `, ${formatBytes(total)}` : ''}`}
    >
      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
        {matched.map(([eafFile, file]) => (
          <li key={eafFile}>
            {nameOf(eafFile)} — <span className="font-mono">{file.name}</span>
            {file.size ? ` (${formatBytes(file.size)})` : ''}
          </li>
        ))}
      </ul>
      {media.unmatched.length > 0 && (
        <>
          <p className="mt-2 text-xs font-medium">
            {media.unmatched.length} file{media.unmatched.length === 1 ? '' : 's'} match no .eaf in
            this batch and will not be uploaded.
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
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
        </>
      )}
    </Panel>
  );
};
