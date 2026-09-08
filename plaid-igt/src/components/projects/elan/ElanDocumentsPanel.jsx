// The documents a run would create, with the first of their text.
//
// The tier rows say where each tier goes and the counts say how much there is,
// but neither answers "what am I about to get". A .eaf holds no running text:
// the document's text is SYNTHESIZED from the tier mapped to Sentences, so the
// only way to know it came out right is to read some. A corpus segmented but
// not yet transcribed shows its placeholder here, which is the fact its owner
// most needs to see before importing 665 of them.

import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/utils/formatBytes';
import { Panel } from '../ImportPanels.jsx';

const PREVIEW_SENTENCES = 3;
const PREVIEW_CHARS = 80;
const LIST_LIMIT = 8;

/** The first few sentences of a built document, as text. */
const previewOf = (doc) => {
  const chars = [...(doc.body ?? '')];
  return (doc.sentences || []).slice(0, PREVIEW_SENTENCES).map((s) => {
    const text = chars.slice(s.begin, s.end).join('').trim();
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  });
};

export const ElanDocumentsPanel = ({ build, onAddRecordings = null }) => {
  const documents = build?.documents ?? [];
  if (!documents.length) return null;
  const listed = documents.slice(0, LIST_LIMIT);
  const preview = previewOf(documents[0]).filter((t) => t !== '');
  return (
    <Panel title={`${documents.length} document${documents.length === 1 ? '' : 's'}`}>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
        {listed.map((doc) => (
          <li key={doc.id}>
            <span className="font-medium text-foreground">{doc.name}</span> · {doc.sentences.length}{' '}
            sentence{doc.sentences.length === 1 ? '' : 's'}
            {doc.mediaFile
              ? ` · ${doc.mediaFile.name}${doc.mediaFile.size ? ` (${formatBytes(doc.mediaFile.size)})` : ''}`
              : // The .eaf names a recording it does not carry, and none was
                // chosen: say so per document rather than only in a warning.
                doc.metadata?.['Media file']
                ? ' · no recording chosen'
                : ''}
          </li>
        ))}
        {documents.length > listed.length && <li>and {documents.length - listed.length} more</li>}
      </ul>
      {onAddRecordings && documents.some((doc) => !doc.mediaFile) && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onAddRecordings}>
          <Upload className="h-4 w-4" /> Add recordings
        </Button>
      )}
      {preview.length > 0 && (
        <>
          <p className="mt-2 text-xs font-medium">
            {documents.length > 1 ? `First sentences of “${documents[0].name}”` : 'First sentences'}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
            {preview.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
};
