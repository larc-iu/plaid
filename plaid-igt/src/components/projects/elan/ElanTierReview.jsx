// The review step of an ELAN import: what the batch holds, what each tier
// becomes, and what the run would write. Shared by the two importers (a new
// project, or new documents in an existing one), which differ only in what a
// field name means. `renderFieldControl` is that difference: a free-text name
// when the fields are about to be created, a picker over the project's own
// fields when they already exist.

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { nodeLabel, ROLES } from '@/import/elan/schema';
import { Panel } from '../ImportPanels.jsx';

const ROLE_LABELS = [
  [ROLES.UTTERANCE, 'Utterances'],
  [ROLES.ALIGNMENT, 'Time alignment'],
  [ROLES.WORD, 'Words'],
  [ROLES.MORPHEME, 'Morphemes'],
  [ROLES.SENTENCE_FIELD, 'Sentence field'],
  [ROLES.WORD_FIELD, 'Word field'],
  [ROLES.MORPH_FIELD, 'Morpheme field'],
  [ROLES.ORTHOGRAPHY, 'Orthography'],
  [ROLES.OFF, 'Don’t import'],
];

export const NAMED_ROLES = new Set([
  ROLES.SENTENCE_FIELD,
  ROLES.WORD_FIELD,
  ROLES.MORPH_FIELD,
  ROLES.ORTHOGRAPHY,
]);

/** The scope a field role writes to, for looking a name up among the project's. */
export const SCOPE_OF_ROLE = {
  [ROLES.SENTENCE_FIELD]: 'Sentence',
  [ROLES.WORD_FIELD]: 'Word',
  [ROLES.MORPH_FIELD]: 'Morpheme',
};

export const SchemaMismatch = ({ comparison, onReset }) => (
  <Panel tone="error" icon={AlertTriangle} title="These files do not share one tier structure">
    <p className="mt-1 text-xs">
      One mapping has to describe the whole batch, so importing a mixture would apply decisions to
      files they were never made for. Import each structure separately, or make the tiers match in
      ELAN first.
    </p>
    <ul className="mt-2 flex flex-col gap-2 text-xs">
      {comparison.differences.map((d, i) => (
        <li key={i}>
          <span className="font-medium">
            {d.files.length} file{d.files.length === 1 ? '' : 's'}
          </span>{' '}
          ({d.files.slice(0, 3).join(', ')}
          {d.files.length > 3 ? `, +${d.files.length - 3} more` : ''}):
          {d.missing.length > 0 && <> missing {d.missing.join(', ')}.</>}
          {d.extra.length > 0 && <> extra {d.extra.join(', ')}.</>}
          {d.nearMiss?.length > 0 && (
            <>
              {' '}
              <span className="font-medium">
                {d.nearMiss.join(', ')} differs only in how it is spelled
              </span>
              , which is likely a typo in the tier name rather than a real difference.
            </>
          )}
        </li>
      ))}
    </ul>
    <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>
      Choose different files
    </Button>
  </Panel>
);

const NearMisses = ({ groups, choices, undecided, editable, onChoose }) => (
  <Panel
    tone={undecided.length ? 'error' : 'warn'}
    icon={AlertTriangle}
    title={`${groups.length} pair${groups.length === 1 ? '' : 's'} of tier names read alike`}
  >
    <p className="mt-1 text-xs">
      Tiers are matched by their exact names, so these are separate tiers unless you say otherwise.
      Two rows that read alike is how a tier gets mapped by mistake and its twin silently dropped,
      so this usually means a typo in the corpus.
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
      <p className="mt-2 text-xs font-medium">
        Decide each pair to continue. Renaming the tiers in ELAN is the durable fix.
      </p>
    )}
  </Panel>
);

/**
 * @param batch  the useElanBatch state
 * @param editable  false while a run is in flight
 * @param renderFieldControl  (node) => ReactNode for a tier in a named role
 */
export const ElanTierReview = ({ batch, editable, renderFieldControl = null }) => {
  const { files, nodes, roles, fieldNames, build, problems } = batch;
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

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tiers</h2>
          <p className="text-sm text-muted-foreground">
            {files.length === 1 ? (
              <>
                One file, {nodes.length} tier{nodes.length === 1 ? '' : 's'}.
              </>
            ) : (
              <>
                {files.length} files, all with the same {nodes.length} tier
                {nodes.length === 1 ? '' : 's'}. Speaker suffixes are ignored when matching, so
                files by different speakers count as the same structure.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {nodes.map((node) => (
            <div key={node.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm"
                  style={{ paddingLeft: `${node.depth * 16}px` }}
                  title={`type ${node.typeRef}${node.stereotype ? `, ${node.stereotype}` : ''}`}
                >
                  <span className="font-medium">{nodeLabel(node)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {node.stereotype ?? 'top level'} · {node.annotationCount}
                    {node.participants.length > 1 ? ` · ${node.participants.length} speakers` : ''}
                    {' · '}
                    <span className="font-mono">{node.tierIds.slice(0, 3).join(' ')}</span>
                    {node.tierIds.length > 3 ? ` +${node.tierIds.length - 3}` : ''}
                  </span>
                </div>
                {NAMED_ROLES.has(roles[node.key]) &&
                  (renderFieldControl ? (
                    renderFieldControl(node)
                  ) : (
                    <Input
                      aria-label={`Name for ${nodeLabel(node)}`}
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
                    {ROLE_LABELS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      </div>

      {problems.length > 0 && (
        <Panel tone="warn" icon={AlertTriangle} title="Finish the mapping">
          <ul className="mt-1 list-inside list-disc text-xs">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Panel>
      )}

      {build && (
        <Panel title="What will be imported">
          <p className="mt-1 text-xs">
            {build.documents.length} document{build.documents.length === 1 ? '' : 's'} ·{' '}
            {build.stats.sentences} sentences · {build.stats.words} words · {build.stats.morphemes}{' '}
            morphemes · {build.stats.alignments} time-aligned segments
            {build.stats.speakers.length > 0 && <> · speakers: {build.stats.speakers.join(', ')}</>}
          </p>
          {build.warnings.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
              {build.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {build && build.stats.skipped.length > 0 && (
        <Panel
          tone="warn"
          icon={AlertTriangle}
          title={`Not imported: ${build.stats.skipped.reduce((n, s) => n + s.values, 0)} annotations on ${build.stats.skipped.length} tier${build.stats.skipped.length === 1 ? '' : 's'}`}
        >
          <p className="mt-1 text-xs">
            These tiers are set to “Don’t import” above. Give one a role to keep it.
          </p>
          <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
            {build.stats.skipped.map((sk) => (
              <li key={sk.label}>
                {sk.tiers.join(', ')} — {sk.values} annotation{sk.values === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
};
