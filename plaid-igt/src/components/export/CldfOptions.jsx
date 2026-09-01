import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Circle, Minus } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { hasLanguageIdentity } from '@/domain/igtConfig';
import { BASELINE, cldfLossSummary, DEFAULT_CLDF_OPTIONS } from '@/export/cldf';

const NONE = '__none__';

// The gloss can come from either scope, so the select encodes both.
const glossValue = (options) =>
  options.glossField ? `${options.glossScope || 'morpheme'}:${options.glossField}` : NONE;

const OptionRow = ({ label, description, children }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">
      <Label className="text-sm font-normal">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
    {children}
  </div>
);

const FieldSelect = ({ value, onChange, options, placeholder = 'Don’t export' }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="h-8 w-56 shrink-0">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {options.map((o) => (
        <SelectItem key={o.value} value={o.value}>
          {o.label}
        </SelectItem>
      ))}
      <SelectItem value={NONE}>{placeholder}</SelectItem>
    </SelectContent>
  </Select>
);

const SummaryList = ({ icon, title, items, tone }) => {
  const Icon = icon;
  return (
    <div className="flex flex-col gap-1">
      <p className={`flex items-center gap-1.5 text-xs font-medium ${tone}`}>
        <Icon className="h-3 w-3 shrink-0" /> {title} ({items.length})
      </p>
      {items.length ? (
        <ul className="flex flex-col gap-0.5 pl-[18px]">
          {items.map((t) => (
            <li key={t} className="truncate text-xs text-muted-foreground">
              {t}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pl-[18px] text-xs text-muted-foreground/60">None</p>
      )}
    </div>
  );
};

/**
 * Step 2 (CLDF): which tier fills each of the format's few slots.
 *
 * CLDF has one Gloss column and one Translated_Text column, so this is a
 * narrowing decision rather than a mapping matrix. Whatever a project annotates
 * beyond those either rides along as a custom column (readable, but invisible
 * to CLDF tools) or is dropped, and the summary at the bottom says which
 * before the export runs.
 */
export const CldfOptions = ({ options, layers, languages, projectId, onChange }) => {
  const o = { ...DEFAULT_CLDF_OPTIONS, ...options };
  const extras = { ...DEFAULT_CLDF_OPTIONS.extras, ...(options?.extras || {}) };
  const set = (patch) => onChange({ ...o, ...patch, extras });
  const setExtras = (patch) => onChange({ ...o, extras: { ...extras, ...patch } });

  const glossOptions = [
    ...layers.morphFields.map((n) => ({ value: `morpheme:${n}`, label: `${n} (morpheme)` })),
    ...layers.wordFields.map((n) => ({ value: `word:${n}`, label: `${n} (word)` })),
  ];
  const sentOptions = layers.sentFields.map((n) => ({ value: n, label: n }));

  // Everything not bound to a CLDF term, with the bucket it would ride in.
  const bound = new Set([o.glossField, o.translationField, o.commentField]);
  const carryable = useMemo(
    () =>
      [
        ...layers.sentFields.map((n) => ({ bucket: 'sentence', name: n, scope: 'sentence' })),
        ...layers.wordFields.map((n) => ({ bucket: 'word', name: n, scope: 'word' })),
        ...layers.morphFields.map((n) => ({ bucket: 'morpheme', name: n, scope: 'morpheme' })),
        ...layers.orthographies.map((n) => ({
          bucket: 'orthographies',
          name: n,
          scope: 'orthography',
        })),
      ].filter((t) => !bound.has(t.name) && o.primaryText !== t.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, o.glossField, o.translationField, o.commentField, o.primaryText],
  );

  const summary = cldfLossSummary(layers, { ...o, extras });
  const languagesSet =
    hasLanguageIdentity(languages?.object) && hasLanguageIdentity(languages?.meta);

  return (
    <div className="flex flex-col gap-4">
      {!languagesSet && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">This project has no language identity yet</p>
            <p className="text-xs text-muted-foreground">
              CLDF identifies data by language. Without a Glottocode this dataset cannot be linked
              to any other.{' '}
              <Link to={`/projects/${projectId}/settings`} className="underline underline-offset-2">
                Set the languages in Settings
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Label>CLDF columns</Label>
        <OptionRow label="Gloss" description="The gloss line aligned with Analyzed_Word.">
          <FieldSelect
            value={glossValue(o)}
            options={glossOptions}
            onChange={(v) =>
              v === NONE
                ? set({ glossField: null })
                : set({ glossScope: v.split(':')[0], glossField: v.slice(v.indexOf(':') + 1) })
            }
          />
        </OptionRow>
        <OptionRow label="Translated_Text" description="The free translation of the sentence.">
          <FieldSelect
            value={o.translationField ?? NONE}
            options={sentOptions}
            onChange={(v) => set({ translationField: v === NONE ? null : v })}
          />
        </OptionRow>
        <OptionRow
          label="Comment"
          description="The CLDF Comment column, filled from one of your sentence fields."
        >
          <FieldSelect
            value={o.commentField ?? NONE}
            options={sentOptions}
            onChange={(v) => set({ commentField: v === NONE ? null : v })}
          />
        </OptionRow>
        <OptionRow label="Primary_Text" description="The unsegmented sentence text.">
          <Select value={o.primaryText} onValueChange={(v) => set({ primaryText: v })}>
            <SelectTrigger className="h-8 w-56 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BASELINE}>Baseline text</SelectItem>
              {layers.orthographies.map((n) => (
                <SelectItem key={n} value={n}>
                  {n} (orthography)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OptionRow>
      </div>

      {carryable.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label>Carry as custom columns</Label>
          <p className="mb-1 text-xs text-muted-foreground">
            CLDF has no term for these, so they become plain columns: readable by humans and by
            spreadsheets, ignored by CLDF tools. Unchecked tiers are left out of the export.
          </p>
          {carryable.map((t) => (
            <label
              key={`${t.bucket}:${t.name}`}
              className="flex cursor-pointer items-center justify-between gap-2 text-sm"
            >
              <span className="truncate">
                {t.name} <span className="text-xs text-muted-foreground">({t.scope})</span>
              </span>
              <Switch
                checked={extras[t.bucket].includes(t.name)}
                onCheckedChange={(on) =>
                  setExtras({
                    [t.bucket]: on
                      ? [...extras[t.bucket], t.name]
                      : extras[t.bucket].filter((n) => n !== t.name),
                  })
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t pt-3">
        <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
          <span>
            <span>Lexicon as EntryTable and SenseTable</span>
            <span className="block text-xs text-muted-foreground">
              The project’s vocabularies become CLDF dictionary components.
            </span>
          </span>
          <Switch
            checked={o.dictionary !== false}
            onCheckedChange={(v) => set({ dictionary: v })}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
          <span>
            <span>Speaker column</span>
            <span className="block text-xs text-muted-foreground">
              From the time-alignment layer, where a sentence has one.
            </span>
          </span>
          <Switch checked={o.speakers !== false} onCheckedChange={(v) => set({ speakers: v })} />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
          <span>
            <span>Include media files</span>
            <span className="block text-xs text-muted-foreground">
              Audio and video go in the zip, listed in a MediaTable.
            </span>
          </span>
          <Switch
            checked={o.includeMedia !== false}
            onCheckedChange={(v) => set({ includeMedia: v })}
          />
        </label>
      </div>

      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
        <p className="text-xs font-medium">What this preset exports</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryList
            icon={ArrowRight}
            title="CLDF terms"
            items={summary.mapped}
            tone="text-foreground"
          />
          <SummaryList
            icon={Circle}
            title="Custom columns"
            items={summary.custom}
            tone="text-foreground"
          />
          <SummaryList
            icon={Minus}
            title="Dropped"
            items={summary.dropped}
            tone="text-destructive"
          />
        </div>
      </div>
    </div>
  );
};
