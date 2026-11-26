// The review step of an ELAN import: what the batch holds, what each tier
// becomes, and what the run would write. Shared by the two importers (a new
// project, or new documents in an existing one), which differ only in what a
// field name means. `renderFieldControl` is that difference: a free-text name
// when the fields are about to be created, a picker over the project's own
// fields when they already exist.

import { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
} from '@ui/components/ui/select';
import { NAMED_ROLES, ROLES } from '@/import/elan/schema';
import { Panel } from '../ImportPanels.jsx';
import { ElanSection } from './ElanSection.jsx';
import { msg, t, tx } from '@ui/lib/i18n.js';
import { shownNodeLabel } from './shownNodeLabel.js';

// What a tier can become, grouped the way the document is built: first the
// text and the pieces it divides into, then the values that hang off those
// pieces. The names are the project's own (a sentence, a word, a morpheme, an
// annotation field), not ELAN's. Each label is a message: the place that
// shows it calls t().
const ROLE_GROUPS = [
  [
    msg('Text'),
    [
      [ROLES.UTTERANCE, msg('Sentences')],
      [ROLES.WORD, msg('Words')],
      [ROLES.MORPHEME, msg('Morphemes')],
      [ROLES.MORPH_TYPE, msg('Morpheme type')],
      [ROLES.ALIGNMENT, msg('Time alignment')],
      [ROLES.ORTHOGRAPHY, msg('Orthography')],
    ],
  ],
  [
    msg('Annotation fields'),
    [
      [ROLES.SENTENCE_FIELD, msg('Sentence field')],
      [ROLES.WORD_FIELD, msg('Word field')],
      [ROLES.MORPH_FIELD, msg('Morpheme field')],
    ],
  ],
];

// The schema's names for how two tier names differ (differenceKind), as
// tokens a select can take.
const DIFFERS_BY = {
  'invisible characters': 'invisibleCharacters',
  'Unicode spelling': 'unicodeSpelling', // i18n-ignore: a key the schema returns
  capitalization: 'capitalization',
  spacing: 'spacing',
  'capitalization and spacing': 'capitalizationAndSpacing',
};

const ROLE_LABEL = Object.fromEntries(ROLE_GROUPS.flatMap(([, options]) => options));
const roleLabel = (role) => (ROLE_LABEL[role] ? t(ROLE_LABEL[role]) : role);

const fileList = (files) =>
  files.length > 3
    ? t('{files}, +{n} more', { files: files.slice(0, 3).join(', '), n: files.length - 3 })
    : files.join(', ');

/** A row's name, with the other names its tier goes by in some files. */
const rowLabel = (node) => [shownNodeLabel(node), ...(node.aliases ?? [])].join(' / ');

export const SchemaMismatch = ({ batch, onReset }) => (
  <>
    {batch.nearMissGroups.length > 0 && (
      <NearMisses
        groups={batch.nearMissGroups}
        choices={batch.nearMissChoices}
        undecided={batch.undecidedNearMisses}
        editable
        onChoose={batch.chooseNearMiss}
      />
    )}
    <Panel tone="error" title={t('These files disagree about what a tier is')}>
      <p className="mt-1 text-xs">
        {t('Import them separately, or make the tiers match in ELAN first.')}
      </p>
      <ul className="mt-2 flex flex-col gap-2 text-xs">
        {batch.comparison.differences.map((d, i) => (
          <li key={i}>
            <span className="font-medium">{d.tier ?? roleLabel(d.role)}</span>:{' '}
            {d.variants
              .map((v) =>
                d.tier
                  ? t('{role} in {files}', { role: roleLabel(v.role), files: fileList(v.files) })
                  : t('“{name}” in {files}', { name: v.name, files: fileList(v.files) }),
              )
              .join(' · ')}
            {d.nearMiss && `. ${t('The names differ only in spelling.')}`}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>
        {t('Choose different files')}
      </Button>
    </Panel>
  </>
);

const NearMisses = ({ groups, choices, undecided, editable, onChoose }) => (
  <Panel
    tone={undecided.length ? 'error' : 'warning'}
    title={t('{n, plural, one {# pair} other {# pairs}} of tier names read alike', {
      n: groups.length,
    })}
  >
    <p className="mt-1 text-xs">
      {t('Tiers are matched by exact name. These read alike, which usually means a typo.')}
    </p>
    <div className="mt-2 flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.fold} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{g.names.join(' / ')}</span>
          <span className="text-muted-foreground">
            {t(
              'differ only in {kind, select, invisibleCharacters {invisible characters} unicodeSpelling {Unicode spelling} capitalization {capitalization} spacing {spacing} capitalizationAndSpacing {capitalization and spacing} other {{by}}}{why, select, mergeFirst {, but their parent tiers differ. Merge those first.} parents {, but their parent tiers differ, so they cannot be merged} types {, but ELAN gives them different types, so they cannot be merged} other {}}',
              {
                kind: DIFFERS_BY[g.differsBy] ?? 'other',
                by: g.differsBy,
                why: g.mergeable
                  ? 'none'
                  : g.mergeFirst
                    ? 'mergeFirst'
                    : g.parentsDiffer
                      ? 'parents'
                      : 'types',
              },
            )}
          </span>
          <Select
            value={choices[g.fold] ?? ''}
            onValueChange={(v) => onChoose(g.fold, v)}
            disabled={!editable}
          >
            <SelectTrigger className="h-7 w-56 text-xs">
              <SelectValue placeholder={t('Decide…')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="separate">{t('Different tiers, keep both')}</SelectItem>
              {g.mergeable &&
                g.names.map((n) => (
                  <SelectItem key={n} value={n}>
                    {t('Same tier, merge as “{name}”', { name: n })}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
    {undecided.length > 0 && (
      <p className="mt-2 text-xs font-medium">{t('Decide each pair to continue.')}</p>
    )}
  </Panel>
);

/**
 * Step 2 of the review: what each tier becomes.
 *
 * @param batch  the useElanBatch state
 * @param editable  false while a run is in flight
 * @param renderFieldControl  (node) => ReactNode for a tier in a named role
 * @param rowNote  (node) => {text, tone?}|null, what choosing this row's name
 *                 does to the project ("new field"), said on the row that does it
 */
export const ElanTierReview = ({
  step = 2,
  batch,
  editable,
  renderFieldControl = null,
  rowNote = null,
}) => {
  const { files, nodes, roles, fieldNames } = batch;
  const [showEmpty, setShowEmpty] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // A corpus template carries tiers nobody has filled in, and a row with
  // nothing in it and nothing to decide is what makes the rest hard to read.
  // One that has been given a role stays in view whatever it holds.
  const isEmpty = (node) => !node.annotationCount && (roles[node.key] ?? ROLES.OFF) === ROLES.OFF;
  const emptyCount = nodes.filter(isEmpty).length;
  const shown = showEmpty ? nodes : nodes.filter((n) => !isEmpty(n));
  return (
    <>
      {batch.nearMissGroups.length > 0 && (
        <NearMisses
          groups={batch.nearMissGroups}
          choices={batch.nearMissChoices}
          undecided={batch.undecidedNearMisses}
          editable={editable}
          onChoose={batch.chooseNearMiss}
        />
      )}

      <ElanSection
        step={step}
        title={t('Tiers')}
        note={
          files.length === 1
            ? t('One file, {n, plural, one {# tier} other {# tiers}}.', { n: nodes.length })
            : nodes.every((n) => (n.fileCount ?? files.length) === files.length)
              ? t('{files} files with the same {n, plural, one {# tier} other {# tiers}}.', {
                  files: files.length,
                  n: nodes.length,
                })
              : t(
                  '{files} files, {n, plural, one {# tier} other {# tiers}}. Not every file has every tier.',
                  { files: files.length, n: nodes.length },
                )
        }
        aside={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('About tier roles')}
            aria-expanded={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <CircleHelp className="h-4 w-4" />
          </Button>
        }
      >
        {showHelp && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {tx(
              'The tier mapped to <b>Sentences</b> carries the transcription: each of its annotations becomes one sentence, and their text becomes the document’s text. Words and morphemes divide that text further, time alignment gives the Media tab its segments, and a field holds one value per sentence, word or morpheme.',
              { b: (c) => <span className="font-medium">{c}</span> },
            )}
            {files.length > 1 &&
              ` ${t('Tiers are matched across files by name and by what they become, wherever they sit in the tree. Speaker suffixes are ignored.')}`}
          </p>
        )}
        <div className="flex flex-col gap-2">
          {shown.map((node) => (
            <div key={node.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm"
                  style={{ paddingLeft: `${node.depth * 16}px` }}
                  title={[
                    node.tierIds.join(', '),
                    t('type {type}', { type: node.typeRef }),
                    node.stereotype ?? t('top level'),
                  ].join(' · ')}
                >
                  <span className="font-medium">{rowLabel(node)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('{n, plural, one {# annotation} other {# annotations}}', {
                      n: node.annotationCount,
                    })}
                    {node.participants.length > 1
                      ? ` · ${t('{n} speakers', { n: node.participants.length })}`
                      : ''}
                    {node.fileCount < files.length
                      ? ` · ${t('in {n} of {total} files', { n: node.fileCount, total: files.length })}`
                      : ''}
                  </span>
                </div>
                {NAMED_ROLES.has(roles[node.key]) &&
                  (renderFieldControl ? (
                    renderFieldControl(node)
                  ) : (
                    <Input
                      aria-label={t('Name for {name}', { name: shownNodeLabel(node) })}
                      value={fieldNames[node.key] ?? ''}
                      disabled={!editable}
                      onChange={(e) => batch.setName(node.key, e.target.value)}
                      className="h-8 w-40 shrink-0"
                    />
                  ))}
                <Select
                  value={roles[node.key] ?? ROLES.OFF}
                  disabled={!editable}
                  onValueChange={(v) => batch.setRole(node.key, v)}
                >
                  <SelectTrigger className="h-8 w-44 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROLES.OFF}>{t('Don’t import')}</SelectItem>
                    {ROLE_GROUPS.map(([group, options]) => (
                      <SelectGroup key={group}>
                        <SelectLabel>{t(group)}</SelectLabel>
                        {options.map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {t(label)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(() => {
                const note = rowNote?.(node);
                return note ? (
                  <p
                    className={`pe-[11.5rem] text-end text-xs ${
                      note.tone === 'warn' ? 'text-warning-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {note.text}
                  </p>
                ) : null;
              })()}
            </div>
          ))}
          {emptyCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEmpty((v) => !v)}
              className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {showEmpty
                ? t('Hide {n, plural, one {# tier} other {# tiers}} with no annotations', {
                    n: emptyCount,
                  })
                : t('Show {n, plural, one {# tier} other {# tiers}} with no annotations', {
                    n: emptyCount,
                  })}
            </button>
          )}
        </div>
      </ElanSection>
    </>
  );
};

/** What stands between the mapping and a good import. Nothing, usually. */
export const ElanProblems = ({ batch }) => {
  const { build, problems } = batch;
  return (
    <>
      {problems.length > 0 && (
        <Panel tone="warning" title={t('Finish the mapping')}>
          <ul className="mt-1 list-inside list-disc text-xs">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Panel>
      )}

      {build && build.warnings.length > 0 && (
        <Panel
          tone="warning"
          title={t('{n, plural, one {# warning} other {# warnings}}', { n: build.warnings.length })}
        >
          <ul className="mt-1 list-inside list-disc text-xs">
            {build.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Panel>
      )}

      {build && build.stats.skipped.length > 0 && (
        <Panel
          tone="warning"
          title={(() => {
            const values = build.stats.skipped.reduce((n, s) => n + s.values, 0);
            const tiers = build.stats.skipped.length;
            return t(
              'Not imported: {values, plural, one {# annotation} other {# annotations}} on {tiers, plural, one {# tier} other {# tiers}}',
              { values, tiers },
            );
          })()}
        >
          <p className="mt-1 text-xs">{t('Set to “Don’t import” in Tiers.')}</p>
          <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
            {build.stats.skipped.map((sk) => (
              <li key={sk.label}>
                {t('{tiers}: {n, plural, one {# annotation} other {# annotations}}', {
                  tiers: sk.tiers.join(', '),
                  n: sk.values,
                })}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
};
