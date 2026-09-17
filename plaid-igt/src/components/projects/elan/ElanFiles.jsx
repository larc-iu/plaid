// Step 1 of the review: what was chosen, and what each file becomes.
//
// One row per .eaf, saying the document it turns into and whether the project
// has it already, with its recording nested under it. This used to be three
// boxes (the files, the documents, the files imported before), each naming the
// same file again, and the person had to join them by eye. A recording no .eaf
// names comes last, since it goes nowhere.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, AudioLines, FileText, Film, Plus, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Progress } from '@ui/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { conversionNeed, conversionNote, estimateMp3Bytes } from '@/domain/media/transcodeToMp3';
import { Panel } from '../ImportPanels.jsx';
import { ElanSection } from './ElanSection.jsx';

// A corpus is hundreds of files, and the first screenful says what the rest say.
const LIST_LIMIT = 12;

/** What a recording will become, once its duration is known. */
const convertedBytes = (seconds) =>
  Number.isFinite(seconds) && seconds > 0 ? estimateMp3Bytes(seconds) : null;

const TONES = {
  warn: 'text-amber-700 dark:text-amber-500',
  error: 'text-destructive',
  muted: 'text-muted-foreground',
};

// `icon` is a component; the alias is a statement rather than a destructuring
// rename because ESLint 9 misses a renamed parameter used only in JSX.
const Row = ({ icon, name, children, nested = false, onRemove }) => {
  const Icon = icon;
  return (
    <li className={`flex items-baseline gap-2 py-1 ${nested ? 'ps-6' : ''}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
      <span className="min-w-0 shrink truncate font-mono text-xs">{name}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-3 text-xs">
        {children}
      </span>
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0 self-center"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <X className="h-3 w-3" />
        </Button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
    </li>
  );
};

const PRIOR_MODES = [
  ['skip', 'Keep them', null],
  ['replace', 'Replace them', 'Deletes each document and everything added to it since.'],
  ['copy', 'Add copies', 'A new document beside each, named with a number.'],
];

/**
 * @param files       parsed .eaf objects (readEaf output)
 * @param mediaFiles  the recordings picked alongside them
 * @param media       matchMediaFiles output for the two
 * @param durations   Map<File, seconds|null>
 * @param maxBytes    the server's media limit, or null when it has not said
 * @param documents   what the mapping builds, one per .eaf, or null until it can
 * @param imported    Map<.eaf file name, the project's document> for files an
 *                    earlier run finished. Null where there is no project yet,
 *                    and then no row says "new" either.
 * @param recordMediaName  whether each recording's file name goes in a Media
 *                    file metadata field, and onRecordMediaName to change it
 */
export const ElanFiles = ({
  step = 1,
  files,
  mediaFiles,
  media,
  durations,
  maxBytes = null,
  editable = true,
  converting = null,
  documents = null,
  imported = null,
  projectId = null,
  priorMode = 'skip',
  onPriorMode = null,
  onAddFiles = null,
  onRemoveEaf = null,
  onRemoveMedia = null,
  onConvert = null,
  recordMediaName = true,
  onRecordMediaName = null,
}) => {
  const [showAll, setShowAll] = useState(false);
  if (!files?.length && !mediaFiles?.length) return null;

  const docOf = new Map((documents || []).map((d) => [d.id, d]));
  const matched = new Set(media.byFile.values());
  const unmatched = (mediaFiles || []).filter((f) => !matched.has(f));

  const needOf = (file) => conversionNeed(file.size, maxBytes);
  const toConvert = (mediaFiles || []).filter((f) => matched.has(f) && needOf(f));
  const required = toConvert.filter((f) => needOf(f) === 'required');
  const anyVideo = toConvert.some((f) => f.type?.startsWith('video/'));
  // A total only means anything once every duration is known.
  const sizes = toConvert.map((f) => convertedBytes(durations.get(f)));
  const totalConverted =
    sizes.length && sizes.every(Boolean) ? sizes.reduce((a, b) => a + b, 0) : null;

  const eafs = files || [];
  const listed = showAll ? eafs : eafs.slice(0, LIST_LIMIT);
  const importedCount = imported ? eafs.filter((f) => imported.has(f.fileName)).length : 0;
  const namesRecording = eafs.some((f) => f.media?.length);

  const recordingRow = (eaf, file) => {
    const need = needOf(file);
    const smaller = convertedBytes(durations.get(file));
    const existing = imported?.get(eaf.fileName);
    // Kept as it is, the file's document is not remade, so its recording has
    // one place left to go.
    const kept = existing && priorMode === 'skip';
    return (
      <Row
        key={`media:${file.name}`}
        nested
        icon={need ? AudioLines : Film}
        name={file.name}
        onRemove={editable && onRemoveMedia ? () => onRemoveMedia(file) : null}
      >
        <span className={TONES.muted}>{formatBytes(file.size)}</span>
        {need && (
          <span className={need === 'required' ? TONES.error : TONES.muted}>
            becomes {smaller ? `a ${formatBytes(smaller)} MP3` : 'an MP3'}
          </span>
        )}
        {kept && (
          <span className={TONES.muted}>
            {existing.mediaUrl ? 'not used, the document has a recording' : 'added to the document'}
          </span>
        )}
      </Row>
    );
  };

  return (
    <ElanSection
      step={step}
      title="Files"
      note={`${eafs.length} .eaf file${eafs.length === 1 ? '' : 's'}${
        mediaFiles?.length
          ? `, ${mediaFiles.length} recording${mediaFiles.length === 1 ? '' : 's'}`
          : ''
      }. Every .eaf becomes one document.`}
      aside={
        editable &&
        onAddFiles && (
          <Button variant="outline" size="sm" onClick={onAddFiles}>
            <Plus className="h-4 w-4" /> Add files
          </Button>
        )
      }
    >
      <ul className="flex flex-col divide-y rounded-md border px-3">
        {listed.map((eaf) => {
          const doc = docOf.get(eaf.fileName);
          const existing = imported?.get(eaf.fileName);
          const recording = media.byFile.get(eaf.fileName);
          const named = eaf.media?.[0]?.relativeUrl || eaf.media?.[0]?.url || '';
          return (
            <li key={`eaf:${eaf.fileName}`} className="py-0.5">
              <ul className="flex flex-col">
                <Row
                  icon={FileText}
                  name={eaf.fileName}
                  onRemove={editable && onRemoveEaf ? () => onRemoveEaf(eaf.fileName) : null}
                >
                  {doc ? (
                    <span className={TONES.muted}>
                      <span aria-hidden="true">→ </span>
                      <span className="font-medium text-foreground">{doc.name}</span> ·{' '}
                      {doc.sentences.length} sentence{doc.sentences.length === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className={TONES.muted}>{eaf.tiers.length} tiers</span>
                  )}
                  {!recording && named && <span className={TONES.warn}>recording not chosen</span>}
                  {imported &&
                    (existing ? (
                      <span className={TONES.warn}>
                        in this project as{' '}
                        <Link
                          to={`/projects/${projectId}/documents/${existing.id}`}
                          className="underline underline-offset-2"
                        >
                          {existing.name}
                        </Link>
                      </span>
                    ) : (
                      <span className={TONES.muted}>new</span>
                    ))}
                </Row>
                {recording && recordingRow(eaf, recording)}
              </ul>
            </li>
          );
        })}
        {unmatched.map((file) => (
          <li key={`media:${file.name}`} className="py-0.5">
            <ul className="flex flex-col">
              <Row
                icon={Film}
                name={file.name}
                onRemove={editable && onRemoveMedia ? () => onRemoveMedia(file) : null}
              >
                <span className={TONES.muted}>{formatBytes(file.size)}</span>
                <span className={TONES.warn}>no .eaf names this file</span>
              </Row>
            </ul>
          </li>
        ))}
      </ul>
      {eafs.length > LIST_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {showAll ? `Show the first ${LIST_LIMIT}` : `Show all ${eafs.length}`}
        </button>
      )}

      {namesRecording && onRecordMediaName && (
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            disabled={!editable}
            checked={recordMediaName}
            onChange={(e) => onRecordMediaName(e.target.checked)}
          />
          Keep each recording’s file name in a Media file field
        </label>
      )}

      {importedCount > 0 && onPriorMode && (
        <Panel
          tone="warn"
          icon={AlertTriangle}
          title={`${importedCount} of these ${importedCount === 1 ? 'files was' : 'files were'} imported before`}
        >
          <div role="radiogroup" className="mt-2 flex flex-col gap-1 text-xs">
            {PRIOR_MODES.map(([mode, label, hint]) => (
              <label key={mode} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="prior-mode"
                  className="mt-0.5"
                  value={mode}
                  disabled={!editable}
                  checked={priorMode === mode}
                  onChange={() => onPriorMode(mode)}
                />
                <span>
                  {label}
                  {hint && <span className="block text-muted-foreground">{hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </Panel>
      )}

      {converting ? (
        <div className="flex flex-col gap-1" aria-live="polite">
          <Progress value={converting.fraction * 100} label="Conversion progress" />
          <p className="text-xs text-muted-foreground">
            Converting {converting.name}
            {converting.total > 1 ? ` (${converting.index + 1} of ${converting.total})` : ''}.
          </p>
        </div>
      ) : (
        toConvert.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs">
              {required.length > 0 ? (
                <span className="font-medium text-destructive">
                  This server accepts {formatBytes(maxBytes)}, so{' '}
                  {required.length === 1 ? 'that recording' : 'those recordings'} cannot be uploaded
                  as {required.length === 1 ? 'it is' : 'they are'}.{' '}
                </span>
              ) : null}
              <span className="text-muted-foreground">
                {conversionNote({ bytes: totalConverted, video: anyVideo })}
              </span>
            </p>
            {editable && onConvert && (
              <div>
                <Button
                  variant={required.length ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => onConvert(toConvert)}
                >
                  <AudioLines className="h-4 w-4" />{' '}
                  {toConvert.length === 1
                    ? `Convert to ${totalConverted ? `a ${formatBytes(totalConverted)} ` : ''}MP3`
                    : `Convert ${toConvert.length} to MP3${
                        totalConverted ? `, about ${formatBytes(totalConverted)}` : ''
                      }`}
                </Button>
              </div>
            )}
          </div>
        )
      )}
    </ElanSection>
  );
};
