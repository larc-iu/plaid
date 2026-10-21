import { useEffect } from 'react';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Switch } from '@ui/components/ui/switch';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { resolveFieldLang } from '@/domain/fieldNames';
import { proposeMetadataMap } from '@/export/presets';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';

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
    <Label htmlFor={id} className="text-sm font-normal">
      {label}
    </Label>
    <Input
      id={id}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-40 font-mono text-xs"
    />
  </div>
);

// The scope a span layer records, from the key this UI groups by.
const SCOPE_NAMES = { sentence: 'Sentence', word: 'Word', morpheme: 'Morpheme' };

// Fields in one scope that go out as the same item type in the same writing
// system. FLEx keeps one value per (type, writing system), so the second one
// imported replaces the first: a real loss, and a silent one.
const clashes = (fields, map, langs, scope) => {
  const byTag = new Map();
  for (const f of fields) {
    const type = map[f];
    if (!type) continue; // not exported
    const key = `${type}|${resolveFieldLang(langs, SCOPE_NAMES[scope], f)}`;
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(f);
  }
  return [...byTag.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([key, fs]) => ({
      fields: fs,
      lang: key.split('|')[1],
      label: ITEM_TYPES[scope].find((t) => t.id === key.split('|')[0])?.label ?? key.split('|')[0],
    }));
};

const FieldMapGroup = ({
  scope,
  title,
  fields,
  map,
  overrides,
  fieldLangs,
  analysis,
  onChange,
  onLang,
}) => {
  if (!fields.length) return null;
  const langs = { overrides, fieldLangs, analysis };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{title}</Label>
      {fields.map((f) => (
        <div key={f} className="flex items-center justify-between gap-2">
          <span className="truncate text-sm">{f}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={map[f] ?? OMIT}
              onValueChange={(v) => {
                const next = { ...map };
                if (v === OMIT) delete next[f];
                else next[f] = v;
                onChange(next);
              }}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ITEM_TYPES[scope].map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
                <SelectItem value={OMIT}>Don’t export</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label={`Language tag for ${f}`}
              value={overrides[f] ?? ''}
              // What the field goes out as when the box is empty: what the
              // field itself records, else the one for glosses and
              // translations.
              placeholder={resolveFieldLang(langs, SCOPE_NAMES[scope], f)}
              onChange={(e) => onLang(f, e.target.value)}
              className="h-8 w-16 font-mono text-xs"
            />
          </div>
        </div>
      ))}
      {clashes(fields, map, langs, scope).map((c) => (
        <Notice key={`${c.label}-${c.lang}`} tone="warning" className="p-2 text-xs">
          <span>
            {c.fields.join(' and ')} both go out as {c.label} in <code>{c.lang}</code>. FLEx keeps
            one value per writing system. Give one of them its own tag.
          </span>
        </Notice>
      ))}
    </div>
  );
};

// Step 2 (flextext): language tags + field → FLEx item-type mapping.
// We don't store ISO writing-system codes, so the preset carries them; FLEx
// prompts to map unknown tags at import time, so imperfect tags are fine.
// What a document metadata field goes out as, the FLEx text field it lands in.
const METADATA_TYPES = [
  { id: 'title', label: 'Title' },
  { id: 'title-abbreviation', label: 'Abbreviation' },
  { id: 'source', label: 'Source' },
  { id: 'comment', label: 'Description' },
];
const AS_COMMENT = '__comment__';

const MetadataMapGroup = ({ fields, map, langs, onChange }) => {
  if (!fields.length) return null;
  const set = (field, patch) => {
    const next = { ...map };
    const entry = { ...next[field], ...patch };
    if (!entry.type) delete next[field];
    else {
      if (!entry.lang) delete entry.lang;
      next[field] = entry;
    }
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Document metadata</Label>
      {fields.map((f) => (
        <div key={f} className="flex items-center justify-between gap-2">
          <span className="truncate text-sm">{f}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={map[f]?.type ?? AS_COMMENT}
              onValueChange={(v) => set(f, { type: v === AS_COMMENT ? null : v })}
            >
              <SelectTrigger className="h-8 w-56" aria-label={`FLEx field for ${f}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METADATA_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
                <SelectItem value={AS_COMMENT}>Description, with its name</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label={`Language tag for ${f}`}
              value={map[f]?.lang ?? ''}
              disabled={!map[f]?.type}
              placeholder={
                map[f]?.type === 'title' ? langs.baseline || 'und' : langs.analysis || 'en'
              }
              onChange={(e) => set(f, { lang: e.target.value.trim() })}
              className="h-8 w-16 font-mono text-xs"
            />
          </div>
        </div>
      ))}
    </div>
  );
};

export const FlextextOptions = ({ options, layers, onChange }) => {
  // A preset made before the metadata mapping was stored is given the one the
  // field names propose, once, when it is opened. Saved with the preset.
  useEffect(() => {
    if (options.metadataMap === undefined) {
      onChange({ ...options, metadataMap: proposeMetadataMap(layers.documentMetadata) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.metadataMap === undefined]);
  const langs = options.langs || {};
  const fieldMap = options.fieldMap || {};
  const overrides = langs.fieldOverrides || {};
  const setLangs = (patch) => onChange({ ...options, langs: { ...langs, ...patch } });
  const setMap = (scope, map) => onChange({ ...options, fieldMap: { ...fieldMap, [scope]: map } });
  // An empty box is not a tag: it drops the override and the field falls back
  // to the language it records or the analysis one.
  const setFieldLang = (field, value) => {
    const next = { ...overrides };
    if (value.trim() === '') delete next[field];
    else next[field] = value.trim();
    setLangs({ fieldOverrides: next });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Language tags</Label>
        <p className="text-xs text-muted-foreground">
          Writing-system codes FLEx will see (e.g. <code>lez</code>, <code>en</code>). Unknown tags
          can be remapped in FLEx at import time. A field goes out under the language it records.
          Set another tag below.
        </p>
        <LangInput
          id="ft-lang-baseline"
          label="Baseline text"
          value={langs.baseline ?? ''}
          placeholder="und"
          onChange={(v) => setLangs({ baseline: v })}
        />
        {layers.orthographies.map((name) => (
          <LangInput
            key={name}
            id={`ft-lang-orth-${name}`}
            label={`Orthography: ${name}`}
            value={langs.orthographies?.[name] ?? ''}
            placeholder="und"
            onChange={(v) => setLangs({ orthographies: { ...langs.orthographies, [name]: v } })}
          />
        ))}
        <LangInput
          id="ft-lang-analysis"
          label="Glosses and translations"
          value={langs.analysis ?? ''}
          placeholder="en"
          onChange={(v) => setLangs({ analysis: v })}
        />
      </div>

      <FieldMapGroup
        scope="sentence"
        title="Sentence fields"
        fields={layers.sentFields}
        map={fieldMap.sentence || {}}
        overrides={overrides}
        fieldLangs={layers.fieldLangs}
        analysis={langs.analysis}
        onChange={(m) => setMap('sentence', m)}
        onLang={setFieldLang}
      />
      <FieldMapGroup
        scope="word"
        title="Word fields"
        fields={layers.wordFields}
        map={fieldMap.word || {}}
        overrides={overrides}
        fieldLangs={layers.fieldLangs}
        analysis={langs.analysis}
        onChange={(m) => setMap('word', m)}
        onLang={setFieldLang}
      />
      <FieldMapGroup
        scope="morpheme"
        title="Morpheme fields"
        fields={layers.morphFields}
        map={fieldMap.morpheme || {}}
        overrides={overrides}
        fieldLangs={layers.fieldLangs}
        analysis={langs.analysis}
        onChange={(m) => setMap('morpheme', m)}
        onLang={setFieldLang}
      />

      <MetadataMapGroup
        fields={layers.documentMetadata || []}
        map={options.metadataMap || {}}
        langs={langs}
        onChange={(m) => onChange({ ...options, metadataMap: m })}
      />

      <div className="flex flex-col gap-3 border-t pt-3">
        <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
          <span>
            <span className="font-medium">Include the lexicon (.lift)</span>
            <span className="block text-xs text-muted-foreground">
              The project’s vocabularies as a LIFT file, which is how FLEx takes a lexicon. A
              .flextext on its own cannot carry one.
            </span>
          </span>
          <Switch
            checked={options.lexicon !== false}
            onCheckedChange={(v) => onChange({ ...options, lexicon: v })}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
          <span>Citation forms from linked lexicon entries</span>
          <Switch
            checked={options.citationForms !== false}
            onCheckedChange={(v) => onChange({ ...options, citationForms: v })}
          />
        </label>
      </div>
    </div>
  );
};
