import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';

const OMIT = '__omit__';

// FLEx <item type> choices per annotation scope.
const ITEM_TYPES = {
  sentence: [
    { id: 'gls', label: 'Free translation (gls)' },
    { id: 'lit', label: 'Literal translation (lit)' },
    { id: 'note', label: 'Note (note)' },
  ],
  word: [
    { id: 'gls', label: 'Word gloss (gls)' },
    { id: 'pos', label: 'Word category (pos)' },
  ],
  morpheme: [
    { id: 'gls', label: 'Morpheme gloss (gls)' },
    { id: 'msa', label: 'Grammatical info (msa)' },
  ],
};

const LangInput = ({ id, label, value, onChange, placeholder }) => (
  <div className="flex items-center justify-between gap-2">
    <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
    <Input
      id={id} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-40 font-mono text-xs"
    />
  </div>
);

const FieldMapGroup = ({ scope, title, fields, map, onChange }) => {
  if (!fields.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{title}</Label>
      {fields.map((f) => (
        <div key={f} className="flex items-center justify-between gap-2">
          <span className="truncate text-sm">{f}</span>
          <Select
            value={map[f] ?? OMIT}
            onValueChange={(v) => {
              const next = { ...map };
              if (v === OMIT) delete next[f]; else next[f] = v;
              onChange(next);
            }}
          >
            <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ITEM_TYPES[scope].map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
              ))}
              <SelectItem value={OMIT}>Don’t export</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
};

// Step 2 (flextext): language tags + field → FLEx item-type mapping.
// We don't store ISO writing-system codes, so the preset carries them; FLEx
// prompts to map unknown tags at import time, so imperfect tags are fine.
export const FlextextOptions = ({ options, layers, onChange }) => {
  const langs = options.langs || {};
  const fieldMap = options.fieldMap || {};
  const setLangs = (patch) => onChange({ ...options, langs: { ...langs, ...patch } });
  const setMap = (scope, map) => onChange({ ...options, fieldMap: { ...fieldMap, [scope]: map } });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Language tags</Label>
        <p className="text-xs text-muted-foreground">
          Writing-system codes FLEx will see (e.g. <code>lez</code>, <code>en</code>).
          Unknown tags can be remapped in FLEx at import time.
        </p>
        <LangInput
          id="ft-lang-baseline" label="Baseline text"
          value={langs.baseline ?? ''} placeholder="und"
          onChange={(v) => setLangs({ baseline: v })}
        />
        {layers.orthographies.map((name) => (
          <LangInput
            key={name} id={`ft-lang-orth-${name}`} label={`Orthography: ${name}`}
            value={langs.orthographies?.[name] ?? ''} placeholder="und"
            onChange={(v) => setLangs({ orthographies: { ...langs.orthographies, [name]: v } })}
          />
        ))}
        <LangInput
          id="ft-lang-analysis" label="Glosses & translations"
          value={langs.analysis ?? ''} placeholder="en"
          onChange={(v) => setLangs({ analysis: v })}
        />
      </div>

      <FieldMapGroup
        scope="sentence" title="Sentence fields" fields={layers.sentFields}
        map={fieldMap.sentence || {}} onChange={(m) => setMap('sentence', m)}
      />
      <FieldMapGroup
        scope="word" title="Word fields" fields={layers.wordFields}
        map={fieldMap.word || {}} onChange={(m) => setMap('word', m)}
      />
      <FieldMapGroup
        scope="morpheme" title="Morpheme fields" fields={layers.morphFields}
        map={fieldMap.morpheme || {}} onChange={(m) => setMap('morpheme', m)}
      />

      <label className="flex cursor-pointer items-center justify-between gap-2 border-t pt-3 text-sm">
        <span>Citation forms from linked lexicon items</span>
        <Switch
          checked={options.citationForms !== false}
          onCheckedChange={(v) => onChange({ ...options, citationForms: v })}
        />
      </label>
    </div>
  );
};
