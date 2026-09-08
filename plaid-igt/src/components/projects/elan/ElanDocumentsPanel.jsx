// The documents a run would create, with the first of their text.
//
// The tier rows say where each tier goes and the counts say how much there is,
// but neither answers "what am I about to get". A .eaf holds no running text:
// the document's text is SYNTHESIZED from the tier mapped to Sentences, so the
// only way to know it came out right is to read some. A corpus segmented but
// not yet transcribed shows its placeholder here, which is the fact its owner
// most needs to see before importing 665 of them.

import { AudioLines, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { conversionNeed, MP3_BITRATE_KBPS } from '@/domain/media/transcodeToMp3';
import { Panel } from '../ImportPanels.jsx';

const HOUR_MB = Math.round((3600 * MP3_BITRATE_KBPS * 1000) / 8 / 1e6);
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

export const ElanDocumentsPanel = ({
  build,
  onAddRecordings = null,
  onConvertRecordings = null,
  maxBytes = null,
  converting = null,
}) => {
  const documents = build?.documents ?? [];
  if (!documents.length) return null;
  const listed = documents.slice(0, LIST_LIMIT);
  const preview = previewOf(documents[0]).filter((t) => t !== '');
  // A recording the server would refuse fails at the END of the import, after
  // the text is already in, so it has to be said here instead.
  const needOf = (doc) => (doc.mediaFile ? conversionNeed(doc.mediaFile.size, maxBytes) : null);
  const refused = documents.filter((doc) => needOf(doc) === 'required');
  const convertible = documents.filter((doc) => needOf(doc));
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
            {needOf(doc) === 'required' && (
              <span className="text-destructive"> · over the {formatBytes(maxBytes)} limit</span>
            )}
          </li>
        ))}
        {documents.length > listed.length && <li>and {documents.length - listed.length} more</li>}
      </ul>
      {converting ? (
        <div className="mt-2 flex flex-col gap-1" aria-live="polite">
          <Progress value={converting.fraction * 100} label="Conversion progress" />
          <p className="text-xs text-muted-foreground">
            Converting {converting.name}
            {converting.total > 1 ? ` (${converting.index + 1} of ${converting.total})` : ''}.
          </p>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onAddRecordings && documents.some((doc) => !doc.mediaFile) && (
            <Button variant="outline" size="sm" onClick={onAddRecordings}>
              <Upload className="h-4 w-4" /> Add recordings
            </Button>
          )}
          {onConvertRecordings && convertible.length > 0 && (
            <Button
              variant={refused.length ? 'default' : 'outline'}
              size="sm"
              onClick={() => onConvertRecordings(convertible.map((doc) => doc.mediaFile))}
            >
              <AudioLines className="h-4 w-4" /> Convert {convertible.length}{' '}
              {convertible.length === 1 ? 'recording' : 'recordings'} to audio
            </Button>
          )}
        </div>
      )}
      {refused.length > 0 && !converting && (
        <p className="mt-2 text-xs font-medium text-destructive">
          This server accepts {formatBytes(maxBytes)}. The import would finish without{' '}
          {refused.length === 1 ? 'that recording' : 'those recordings'}.
        </p>
      )}
      {convertible.length > 0 && !converting && (
        <p className="mt-1 text-xs text-muted-foreground">
          Converting sends the sound alone, as mono MP3 at 16 kHz: about {HOUR_MB} MB an hour, with
          the same timing. The picture and the fidelity for phonetic work are lost.
        </p>
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
