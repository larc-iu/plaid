// Step 1 of the review: what was chosen, and what each file becomes.
//
// One row per .eaf, saying the document it turns into and whether the project
// has it already, with its recording nested under it. This used to be three
// boxes (the files, the documents, the files imported before), each naming the
// same file again, and the person had to join them by eye. A recording no .eaf
// names comes last, since it goes nowhere.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines, FileText, Film, Plus, X } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Progress } from '@ui/components/ui/progress';
import { formatBytes } from '@/utils/formatBytes';
import { msg, t, tx } from '@ui/lib/i18n.js';
import { conversionNeed, conversionNote, estimateMp3Bytes } from '@/domain/media/transcodeToMp3';
import { FALLBACK_RATE, SMALL_RATE, mixBytes, mixRate } from '@/domain/media/mixdown';
import { mixesTracks } from '@/import/elan/buildDocuments';
import { Panel } from '../ImportPanels.jsx';
import { ElanSection } from './ElanSection.jsx';

// A corpus is hundreds of files, and the first screenful says what the rest say.
const LIST_LIMIT = 12;

/** Seconds as the review shows an offset: up to milliseconds, no trailing zeros. */
const seconds = (s) => s.toFixed(3).replace(/\.?0+$/, '');

/** What a recording will become, once its duration is known. */
const convertedBytes = (seconds) =>
  Number.isFinite(seconds) && seconds > 0 ? estimateMp3Bytes(seconds) : null;

const TONES = {
  warn: 'text-warning-foreground',
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
          aria-label={t('Remove {name}', { name })}
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
  ['skip', msg('Keep them'), null],
  ['replace', msg('Replace them'), msg('Deletes each document and everything added to it since.')],
  ['copy', msg('Add copies'), msg('A new document beside each, named with a number.')],
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
 * @param sampleRates Map<File, Hz|null>, for the size a mix comes to
 * @param mixQuality  'full' or 'small', the quality of a mix of several
 *                    recordings on one document, and onMixQuality to change it
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
  onStopConverting = null,
  recordMediaName = true,
  onRecordMediaName = null,
  sampleRates = null,
  mixQuality = 'full',
  onMixQuality = null,
}) => {
  const [showAll, setShowAll] = useState(false);
  if (!files?.length && !mediaFiles?.length) return null;

  const docOf = new Map((documents || []).map((d) => [d.id, d]));
  // Every recording some file takes, alone or as one of several.
  const matched = new Set([
    ...media.byFile.values(),
    ...[...(media.tracks?.values() ?? [])].flatMap((ts) => ts.map((tr) => tr.file).filter(Boolean)),
  ]);
  const unmatched = (mediaFiles || []).filter((f) => !matched.has(f));
  // Chosen for a file whose recordings are not mixed, and not its recording.
  const chosenOf = (eaf) => (media.tracks?.get(eaf.fileName) ?? []).filter((tr) => tr.file);
  const notUsed = new Set(
    (files || []).flatMap((eaf) =>
      mixesTracks(chosenOf(eaf))
        ? []
        : chosenOf(eaf)
            .map((tr) => tr.file)
            .filter((f) => f !== media.byFile.get(eaf.fileName)),
    ),
  );

  // The documents whose several recordings are mixed into one, with the size
  // each mix comes to once every recording's length is known.
  const mixes = (documents || [])
    .filter((d) => d.mediaTracks?.length >= 2)
    .map((d) => {
      const tracks = d.mediaTracks.map((tr) => ({
        seconds: durations.get(tr.file),
        sampleRate: sampleRates?.get(tr.file) ?? FALLBACK_RATE,
        offset: tr.offset,
      }));
      const known = tracks.every((tr) => Number.isFinite(tr.seconds));
      return {
        doc: d,
        bytes: known ? { full: mixBytes(tracks, 'full'), small: mixBytes(tracks, 'small') } : null,
        rate: mixRate(tracks, 'full'),
      };
    });
  const mixTotal = (q) =>
    mixes.length && mixes.every((m) => m.bytes) ? mixes.reduce((n, m) => n + m.bytes[q], 0) : null;
  const overLimit = mixes.filter(
    (m) => maxBytes != null && m.bytes && m.bytes[mixQuality] > maxBytes,
  );

  const needOf = (file) => conversionNeed(file.size, maxBytes);
  const toConvert = (mediaFiles || []).filter(
    (f) => matched.has(f) && !notUsed.has(f) && needOf(f),
  );
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

  // `at` tells apart two recordings of one name (from two folders).
  const recordingRow = (eaf, file, track = null, at = 0) => {
    const unused = notUsed.has(file);
    const need = !track && !unused && needOf(file);
    const smaller = convertedBytes(durations.get(file));
    const existing = imported?.get(eaf.fileName);
    // Kept as it is, the file's document is not remade, so its recording has
    // one place left to go.
    const kept = existing && priorMode === 'skip' && !unused;
    return (
      <Row
        key={`media:${at}:${file.name}`}
        nested
        icon={need ? AudioLines : Film}
        name={file.name}
        onRemove={editable && onRemoveMedia ? () => onRemoveMedia(file) : null}
      >
        <span className={TONES.muted}>
          {formatBytes(file.size, { against: need === 'required' ? maxBytes : null })}
        </span>
        {track?.speaker && <span className={TONES.muted}>{track.speaker}</span>}
        {track && track.offset !== 0 && (
          <span className={TONES.muted}>
            {track.offset < 0
              ? t('first {s} s skipped', { s: seconds(-track.offset) })
              : t('from {s} s', { s: seconds(track.offset) })}
          </span>
        )}
        {unused && <span className={TONES.muted}>{t('not used')}</span>}
        {need && (
          <span className={need === 'required' ? TONES.error : TONES.muted}>
            {smaller
              ? t('becomes a {size} MP3', { size: formatBytes(smaller) })
              : t('becomes an MP3')}
          </span>
        )}
        {kept && (
          <span className={TONES.muted}>
            {existing.mediaUrl
              ? t('not used, the document has a recording')
              : t('added to the document')}
          </span>
        )}
      </Row>
    );
  };

  // A recording the file names and nobody chose.
  const missingRow = (eaf, name, at = 0) => (
    <Row key={`missing:${at}:${name}`} nested icon={Film} name={name}>
      <span className={TONES.warn}>{t('recording not chosen')}</span>
    </Row>
  );

  return (
    <ElanSection
      step={step}
      title={t('Files')}
      note={
        mediaFiles?.length
          ? t(
              '{n, plural, one {# annotation file} other {# annotation files}}, {recordings, plural, one {# recording} other {# recordings}}. Every annotation file becomes one document.',
              { n: eafs.length, recordings: mediaFiles.length },
            )
          : t(
              '{n, plural, one {# annotation file} other {# annotation files}}. Every annotation file becomes one document.',
              { n: eafs.length },
            )
      }
      aside={
        editable &&
        onAddFiles && (
          <Button variant="outline" size="sm" onClick={onAddFiles}>
            <Plus className="h-4 w-4" /> {t('Add files')}
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
          // Several recordings named by one file: a row each, chosen or not.
          const tracks = media.tracks?.get(eaf.fileName) ?? [];
          const several = tracks.length >= 2 ? tracks : null;
          const mixing = mixesTracks(chosenOf(eaf));
          const mixed = doc?.mediaTracks ?? null;
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
                      {t('{n, plural, one {# sentence} other {# sentences}}', {
                        n: doc.sentences.length,
                      })}
                    </span>
                  ) : (
                    <span className={TONES.muted}>
                      {t('{n, plural, one {# tier} other {# tiers}}', { n: eaf.tiers.length })}
                    </span>
                  )}
                  {!recording && named && !several && (
                    <span className={TONES.warn}>{t('recording not chosen')}</span>
                  )}
                  {mixed && (
                    <span className={TONES.muted}>
                      {t('{n, plural, one {# recording} other {# recordings}}, mixed into one', {
                        n: mixed.length,
                      })}
                    </span>
                  )}
                  {imported &&
                    (existing ? (
                      <span className={TONES.warn}>
                        {tx('in this project as <a>{name}</a>', {
                          name: existing.name,
                          a: (c) => (
                            <Link
                              to={`/projects/${projectId}/documents/${existing.id}`}
                              className="underline underline-offset-2"
                            >
                              {c}
                            </Link>
                          ),
                        })}
                      </span>
                    ) : (
                      <span className={TONES.muted}>{t('new')}</span>
                    ))}
                </Row>
                {several
                  ? several.map((tr, at) =>
                      !tr.file
                        ? missingRow(eaf, tr.name, at)
                        : mixing
                          ? recordingRow(
                              eaf,
                              tr.file,
                              mixed?.find((m) => m.file === tr.file) ?? { offset: 0, speaker: '' },
                              at,
                            )
                          : recordingRow(eaf, tr.file, null, at),
                    )
                  : recording && recordingRow(eaf, recording)}
              </ul>
            </li>
          );
        })}
        {unmatched.map((file, at) => (
          <li key={`media:${at}:${file.name}`} className="py-0.5">
            <ul className="flex flex-col">
              <Row
                icon={Film}
                name={file.name}
                onRemove={editable && onRemoveMedia ? () => onRemoveMedia(file) : null}
              >
                <span className={TONES.muted}>{formatBytes(file.size)}</span>
                <span className={TONES.warn}>{t('no annotation file names this file')}</span>
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
          {showAll
            ? t('Show the first {n}', { n: LIST_LIMIT })
            : t('Show all {n}', { n: eafs.length })}
        </button>
      )}

      {mixes.length > 0 && (
        <div className="flex flex-col gap-2 text-xs">
          <div role="radiogroup" aria-label={t('Mix quality')} className="flex flex-col gap-1">
            {[
              [
                'full',
                t('Full quality ({khz} kHz)', {
                  khz: Math.round(Math.max(...mixes.map((m) => m.rate)) / 100) / 10,
                }),
              ],
              ['small', t('Smaller ({khz} kHz)', { khz: SMALL_RATE / 1000 })],
            ].map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="mix-quality"
                  value={value}
                  disabled={!editable}
                  checked={mixQuality === value}
                  onChange={() => onMixQuality?.(value)}
                />
                <span>{label}</span>
                {mixTotal(value) != null && (
                  <span className={TONES.muted}>
                    ·{' '}
                    {mixes.length > 1
                      ? t('{size} in all', {
                          size: formatBytes(mixTotal(value), { against: maxBytes }),
                        })
                      : formatBytes(mixTotal(value), { against: maxBytes })}
                  </span>
                )}
              </label>
            ))}
          </div>
          {overLimit.length > 0 && (
            <p className="font-medium text-destructive">
              {t('This server accepts {size}.', { size: formatBytes(maxBytes) })}{' '}
              {overLimit.length === 1
                ? t('The mix for {name} is {size}.', {
                    name: overLimit[0].doc.name,
                    size: formatBytes(overLimit[0].bytes[mixQuality], { against: maxBytes }),
                  })
                : t('{n} mixes are larger.', { n: overLimit.length })}
            </p>
          )}
        </div>
      )}

      {namesRecording && onRecordMediaName && (
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            disabled={!editable}
            checked={recordMediaName}
            onChange={(e) => onRecordMediaName(e.target.checked)}
          />
          {t('Keep each recording’s file name in a Media file field')}
        </label>
      )}

      {importedCount > 0 && onPriorMode && (
        <Panel
          tone="warning"
          title={t(
            '{n, plural, one {{n} of these files was} other {{n} of these files were}} imported before',
            { n: importedCount },
          )}
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
                  {t(label)}
                  {hint && <span className="block text-muted-foreground">{t(hint)}</span>}
                </span>
              </label>
            ))}
          </div>
        </Panel>
      )}

      {converting ? (
        <div className="flex flex-col gap-1" aria-live="polite">
          <Progress value={converting.fraction * 100} label={t('Conversion progress')} />
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {converting.stopping
                ? t('Stopping.')
                : converting.total > 1
                  ? t('Converting {name} ({i} of {total}).', {
                      name: converting.name,
                      i: converting.index + 1,
                      total: converting.total,
                    })
                  : t('Converting {name}.', { name: converting.name })}
            </p>
            {onStopConverting && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={onStopConverting}
                disabled={converting.stopping}
              >
                {t('Stop')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        toConvert.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs">
              {required.length > 0 ? (
                <span className="font-medium text-destructive">
                  {t(
                    'This server accepts {size}, so {n, plural, one {that recording cannot be uploaded as it is} other {those recordings cannot be uploaded as they are}}.',
                    {
                      size: formatBytes(maxBytes, {
                        against: Math.min(...required.map((f) => f.size)),
                      }),
                      n: required.length,
                    },
                  )}{' '}
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
                    ? totalConverted
                      ? t('Convert to a {size} MP3', { size: formatBytes(totalConverted) })
                      : t('Convert to MP3')
                    : totalConverted
                      ? t('Convert {n} to MP3, about {size}', {
                          n: toConvert.length,
                          size: formatBytes(totalConverted),
                        })
                      : t('Convert {n} to MP3', { n: toConvert.length })}
                </Button>
              </div>
            )}
          </div>
        )
      )}
    </ElanSection>
  );
};
