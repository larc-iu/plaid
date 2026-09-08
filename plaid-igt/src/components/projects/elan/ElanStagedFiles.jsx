// Everything the user has chosen, in one list, with what will happen to each.
//
// The files come in two kinds and used to be shown in three places: a drop
// zone that named only .eaf files, a documents panel that mentioned recordings
// in passing, and a warning panel for the ones that matched nothing. A person
// choosing files wants one answer to one question — did what I picked land
// where I meant it to — so this is that list, and the right-hand column is
// where anything that needs saying gets said.

import { AudioLines, FileText, Film, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { conversionNeed, estimateMp3Bytes, MP3_BITRATE_KBPS } from '@/domain/media/transcodeToMp3';
import { Panel } from '../ImportPanels.jsx';

const HOUR_MB = Math.round((3600 * MP3_BITRATE_KBPS * 1000) / 8 / 1e6);

/** What a recording will become, once its duration is known. */
const convertedBytes = (seconds) =>
  Number.isFinite(seconds) && seconds > 0 ? estimateMp3Bytes(seconds) : null;

const Row = ({ icon: Icon, name, detail, status, tone, onRemove }) => (
  <li className="flex items-baseline gap-2 py-0.5">
    <Icon className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
    <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
    {status && (
      <span
        className={`shrink-0 text-xs ${
          tone === 'warn'
            ? 'text-amber-700 dark:text-amber-500'
            : tone === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground'
        }`}
      >
        {status}
      </span>
    )}
    {onRemove ? (
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0"
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

/**
 * @param files       parsed .eaf objects (readEaf output)
 * @param mediaFiles  the recordings picked alongside them
 * @param media       matchMediaFiles output for the two
 * @param durations   Map<File, seconds|null>
 * @param maxBytes    the server's media limit, or null when it has not said
 */
export const ElanStagedFiles = ({
  files,
  mediaFiles,
  media,
  durations,
  maxBytes = null,
  editable = true,
  converting = null,
  onAddFiles = null,
  onRemoveEaf = null,
  onRemoveMedia = null,
  onConvert = null,
}) => {
  if (!files?.length && !mediaFiles?.length) return null;

  // Which .eaf each recording ended up with, inverted from the match.
  const eafOf = new Map();
  for (const [eafFile, file] of media.byFile.entries()) eafOf.set(file, eafFile);

  const needOf = (file) => conversionNeed(file.size, maxBytes);
  const toConvert = (mediaFiles || []).filter((f) => eafOf.has(f) && needOf(f));
  const required = toConvert.filter((f) => needOf(f) === 'required');
  const anyVideo = toConvert.some((f) => f.type?.startsWith('video/'));
  // A total only means anything once every duration is known.
  const sizes = toConvert.map((f) => convertedBytes(durations.get(f)));
  const totalConverted =
    sizes.length && sizes.every(Boolean) ? sizes.reduce((a, b) => a + b, 0) : null;

  return (
    <Panel title={`${(files?.length ?? 0) + (mediaFiles?.length ?? 0)} files`}>
      <ul className="mt-1 flex flex-col">
        {(files || []).map((eaf) => {
          const named = eaf.media?.[0]?.relativeUrl || eaf.media?.[0]?.url || '';
          const has = media.byFile.has(eaf.fileName);
          return (
            <Row
              key={`eaf:${eaf.fileName}`}
              icon={FileText}
              name={eaf.fileName}
              detail={`${eaf.tiers.length} tiers`}
              status={!has && named ? 'recording not chosen' : null}
              tone="warn"
              onRemove={editable && onRemoveEaf ? () => onRemoveEaf(eaf.fileName) : null}
            />
          );
        })}
        {(mediaFiles || []).map((file) => {
          const eafFile = eafOf.get(file);
          const need = eafFile ? needOf(file) : null;
          const smaller = convertedBytes(durations.get(file));
          // "audio" says nothing about a .wav, which is audio already. The
          // size is the point, so the size is what the row says.
          const status = !eafFile
            ? 'no .eaf names this file'
            : need
              ? `becomes ${smaller ? `a ${formatBytes(smaller)} MP3` : 'an MP3'}`
              : `for ${eafFile}`;
          return (
            <Row
              key={`media:${file.name}`}
              icon={need ? AudioLines : Film}
              name={file.name}
              detail={formatBytes(file.size)}
              status={status}
              tone={!eafFile ? 'warn' : need === 'required' ? 'error' : 'muted'}
              onRemove={editable && onRemoveMedia ? () => onRemoveMedia(file) : null}
            />
          );
        })}
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
        <>
          {toConvert.length > 0 && (
            <p className="mt-2 text-xs">
              {required.length > 0 ? (
                <span className="font-medium text-destructive">
                  This server accepts {formatBytes(maxBytes)}, so{' '}
                  {required.length === 1 ? 'that recording' : 'those recordings'} cannot be uploaded
                  as {required.length === 1 ? 'it is' : 'they are'}.{' '}
                </span>
              ) : null}
              <span className="text-muted-foreground">
                Mono at 16 kHz, timed exactly as the original: clear enough to transcribe from, too
                coarse for phonetic measurement
                {anyVideo ? ', and without the picture' : ''}.
                {totalConverted ? '' : ` An MP3 is about ${HOUR_MB} MB an hour.`}
              </span>
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {editable && onAddFiles && (
              <Button variant="outline" size="sm" onClick={onAddFiles}>
                <Plus className="h-4 w-4" /> Add files
              </Button>
            )}
            {editable && onConvert && toConvert.length > 0 && (
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
            )}
          </div>
        </>
      )}
    </Panel>
  );
};
