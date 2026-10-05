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
import { NAMED_ROLES, nodeLabel, ROLES } from '@/import/elan/schema';
import { Panel } from '../ImportPanels.jsx';
import { ElanSection } from './ElanSection.jsx';

// What a tier can become, grouped the way the document is built: first the
// text and the pieces it divides into, then the values that hang off those
// pieces. The names are the project's own (a sentence, a word, a morpheme, an
// annotation field), not ELAN's.
const ROLE_GROUPS = [
  [
    'Text',
    [
      [ROLES.UTTERANCE, 'Sentences'],
      [ROLES.WORD, 'Words'],
      [ROLES.MORPHEME, 'Morphemes'],
      [ROLES.MORPH_TYPE, 'Morpheme type'],
      [ROLES.ALIGNMENT, 'Time alignment'],
      [ROLES.ORTHOGRAPHY, 'Orthography'],
    ],
  ],
  [
    'Annotation fields',
    [
      [ROLES.SENTENCE_FIELD, 'Sentence field'],
      [ROLES.WORD_FIELD, 'Word field'],
      [ROLES.MORPH_FIELD, 'Morpheme field'],
    ],
  ],
];

const ROLE_LABEL = Object.fromEntries(ROLE_GROUPS.flatMap(([, options]) => options));

const fileList = (files) =>
  files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');

/** A row's name, with the other names its tier goes by in some files. */
const rowLabel = (node) => [nodeLabel(node), ...(node.aliases ?? [])].join(' / ');

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
    <Panel tone="error" title="These files disagree about what a tier is">
      <p className="mt-1 text-xs">Import them separately, or make the tiers match in ELAN first.</p>
      <ul className="mt-2 flex flex-col gap-2 text-xs">
        {batch.comparison.differences.map((d, i) => (
          <li key={i}>
            <span className="font-medium">{d.tier ?? ROLE_LABEL[d.role]}</span>:{' '}
            {d.variants
              .map((v) =>
                d.tier
                  ? `${ROLE_LABEL[v.role]} in ${fileList(v.files)}`
                  : `“${v.name}” in ${fileList(v.files)}`,
              )
              .join(' · ')}
            {d.nearMiss && '. The names differ only in spelling.'}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>
        Choose different files
      </Button>
    </Panel>
  </>
);

const NearMisses = ({ groups, choices, undecided, editable, onChoose }) => (
  <Panel
    tone={undecided.length ? 'error' : 'warning'}
    title={`${groups.length} pair${groups.length === 1 ? '' : 's'} of tier names read alike`}
  >
    <p className="mt-1 text-xs">
      Tiers are matched by exact name. These read alike, which usually means a typo.
    </p>
    <div className="mt-2 flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.fold} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{g.names.join(' / ')}</span>
          <span className="text-muted-foreground">
            differ only in {g.differsBy}
            {!g.mergeable && ', but ELAN gives them different types, so they cannot be merged'}
          </span>
          <Select
            value={choices[g.fold] ?? ''}
            onValueChange={(v) => onChoose(g.fold, v)}
            disabled={!editable}
          >
            <SelectTrigger className="h-7 w-56 text-xs">
              <SelectValue placeholder="Decide…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="separate">Different tiers, keep both</SelectItem>
              {g.mergeable &&
                g.names.map((n) => (
                  <SelectItem key={n} value={n}>
                    Same tier, merge as “{n}”
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
    {undecided.length > 0 && (
      <p className="mt-2 text-xs font-medium">Decide each pair to continue.</p>
    )}
  </Panel>
);

/**
 * Step 2 of the review: what each tier becomes.
 *
 * @param batch  the useElanBatch state
 * @param editable  false while a run is in flight
 * @param mappingEditable  whether the roles and field names can be changed;
 *                 a resume locks them to the answers the first run was given
 * @param renderFieldControl  (node) => ReactNode for a tier in a named role
 * @param rowNote  (node) => {text, tone?}|null, what choosing this row's name
 *                 does to the project ("new field"), said on the row that does it
 */
export const ElanTierReview = ({
  step = 2,
  batch,
  editable,
  mappingEditable = editable,
  renderFieldControl = null,
  rowNote = null,
}) => {
  const { files, nodes, roles, fieldNames } = batch;
  // A locked mapping still lets an unanswered pair of tier names be decided.
  // Import waits on every pair, and a resume whose record has no answer for
  // one (a record written before the answers were kept, or a pair that only
  // appears once an .eaf is taken out of the batch) has no other way on.
  const decidable = editable && (mappingEditable || batch.undecidedNearMisses.length > 0);
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
          editable={decidable}
          onChoose={batch.chooseNearMiss}
        />
      )}

      <ElanSection
        step={step}
        title="Tiers"
        note={
          files.length === 1
            ? `One file, ${nodes.length} tier${nodes.length === 1 ? '' : 's'}.`
            : nodes.every((n) => (n.fileCount ?? files.length) === files.length)
              ? `${files.length} files with the same ${nodes.length} tier${nodes.length === 1 ? '' : 's'}.`
              : `${files.length} files, ${nodes.length} tier${nodes.length === 1 ? '' : 's'}. Not every file has every tier.`
        }
        aside={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="About tier roles"
            aria-expanded={showHelp}
            onClick={() => setShowHelp((v) => !v)}
          >
            <CircleHelp className="h-4 w-4" />
          </Button>
        }
      >
        {showHelp && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            The tier mapped to <span className="font-medium">Sentences</span> carries the
            transcription: each of its annotations becomes one sentence, and their text becomes the
            document&rsquo;s text. Words and morphemes divide that text further, time alignment
            gives the Media tab its segments, and a field holds one value per sentence, word or
            morpheme.
            {files.length > 1 &&
              ' Tiers are matched across files by name and by what they become, wherever they sit in the tree. Speaker suffixes are ignored.'}
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
                    `type ${node.typeRef}`,
                    node.stereotype ?? 'top level',
                  ].join(' · ')}
                >
                  <span className="font-medium">{rowLabel(node)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {node.annotationCount} annotation{node.annotationCount === 1 ? '' : 's'}
                    {node.participants.length > 1 ? ` · ${node.participants.length} speakers` : ''}
                    {node.fileCount < files.length
                      ? ` · in ${node.fileCount} of ${files.length} files`
                      : ''}
                  </span>
                </div>
                {NAMED_ROLES.has(roles[node.key]) &&
                  (renderFieldControl ? (
                    renderFieldControl(node)
                  ) : (
                    <Input
                      aria-label={`Name for ${nodeLabel(node)}`}
                      value={fieldNames[node.key] ?? ''}
                      disabled={!mappingEditable}
                      onChange={(e) => batch.setName(node.key, e.target.value)}
                      className="h-8 w-40 shrink-0"
                    />
                  ))}
                <Select
                  value={roles[node.key] ?? ROLES.OFF}
                  disabled={!mappingEditable}
                  onValueChange={(v) => batch.setRole(node.key, v)}
                >
                  <SelectTrigger className="h-8 w-44 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROLES.OFF}>Don’t import</SelectItem>
                    {ROLE_GROUPS.map(([group, options]) => (
                      <SelectGroup key={group}>
                        <SelectLabel>{group}</SelectLabel>
                        {options.map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
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
              {showEmpty ? 'Hide' : 'Show'} {emptyCount} tier{emptyCount === 1 ? '' : 's'} with no
              annotations
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
        <Panel tone="warning" title="Finish the mapping">
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
          title={`${build.warnings.length} warning${build.warnings.length === 1 ? '' : 's'}`}
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
            return `Not imported: ${values} annotation${values === 1 ? '' : 's'} on ${tiers} tier${tiers === 1 ? '' : 's'}`;
          })()}
        >
          <p className="mt-1 text-xs">Set to “Don’t import” in Tiers.</p>
          <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
            {build.stats.skipped.map((sk) => (
              <li key={sk.label}>
                {sk.tiers.join(', ')}: {sk.values} annotation{sk.values === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
};
