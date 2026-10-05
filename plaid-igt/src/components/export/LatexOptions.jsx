import { ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Toggle } from './PlainTextOptions.jsx';
import {
  latexLayout,
  latexVocabulary,
  storedLatexVocabulary,
  ROW_KINDS,
  VOCAB_SCOPES,
} from '@/export/latexBook';
import { fieldLabel } from '@/domain/vocabFields';

const SCOPE_LABEL = {
  [ROW_KINDS.ORTHOGRAPHY]: 'Orthography',
  [ROW_KINDS.WORD_FIELD]: 'Word field',
  [ROW_KINDS.MORPHEME_FIELD]: 'Morpheme field',
};

const rowName = (row) =>
  row.kind === ROW_KINDS.WORDS
    ? 'Words'
    : row.kind === ROW_KINDS.MORPHEMES
      ? 'Morphemes'
      : row.name;

const move = (list, i, by) => {
  const out = [...list];
  [out[i], out[i + by]] = [out[i + by], out[i]];
  return out;
};

// One ordered list of switchable lines, with the move buttons the project's
// field settings use.
const OrderedList = ({ title, items, nameOf, scopeOf = () => null, onChange }) => (
  <div className="flex flex-col gap-1.5">
    <Label>{title}</Label>
    <ol className="flex flex-col rounded-md border">
      {items.map((item, i) => {
        const name = nameOf(item);
        const scope = scopeOf(item);
        return (
          <li
            key={`${item.kind ?? 'sentence'}:${item.name ?? ''}`}
            className="flex items-center gap-2 border-t px-3 py-1 first:border-t-0"
          >
            <label className="flex flex-1 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={item.on}
                onChange={(e) =>
                  onChange(items.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))
                }
              />
              <span>{name}</span>
              {scope && <span className="text-xs text-muted-foreground">{scope}</span>}
            </label>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onChange(move(items, i, -1))}
              disabled={i === 0}
              title="Move up"
              aria-label={`Move ${name} up`}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onChange(move(items, i, 1))}
              disabled={i === items.length - 1}
              title="Move down"
              aria-label={`Move ${name} down`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </li>
        );
      })}
    </ol>
  </div>
);

// The vocabulary chapter: whether there is one, which entries it lists, which
// vocabularies and fields, and whether the texts show entry numbers. Any
// change stores every choice.
const VocabularyOptions = ({ choice, onChange }) => {
  const set = (patch) => onChange(storedLatexVocabulary({ ...choice, ...patch }));
  const setVocab = (id, patch) =>
    set({ vocabularies: choice.vocabularies.map((v) => (v.id === id ? { ...v, ...patch } : v)) });
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <Toggle
        label="Vocabulary chapter"
        checked={choice.include}
        onChange={(v) => set({ include: v })}
      />
      {choice.include && (
        <div className="flex flex-col gap-3 pl-3">
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-sm font-medium">Entries</legend>
            {[
              [VOCAB_SCOPES.USED, 'Used in the texts'],
              [VOCAB_SCOPES.ALL, 'All'],
            ].map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="latex-vocab-scope"
                  checked={choice.scope === value}
                  onChange={() => set({ scope: value })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {choice.vocabularies.map((v) => (
            <div key={v.id} className="flex flex-col gap-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={v.on}
                  onChange={(e) => setVocab(v.id, { on: e.target.checked })}
                />
                {v.name}
              </label>
              {v.on && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6">
                  {v.fields.map((f) => (
                    <label
                      key={f.name}
                      className="flex cursor-pointer items-center gap-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={f.on}
                        onChange={(e) =>
                          setVocab(v.id, {
                            fields: v.fields.map((x) =>
                              x.name === f.name ? { ...x, on: e.target.checked } : x,
                            ),
                          })
                        }
                      />
                      {fieldLabel(f.name)}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <Toggle
        label="Entry numbers in the texts"
        checked={choice.numbersInTexts}
        onChange={(v) => set({ numbersInTexts: v })}
      />
      <p className="text-xs text-muted-foreground">
        A linked word or morpheme whose entry has a number shows it, as in kai₁.
      </p>
    </div>
  );
};

// Step 2 (LaTeX book): which lines each example shows and in what order, the
// sentence fields under it, the metadata switch and the vocabulary. Any change
// stores the whole order.
export const LatexOptions = ({ options, layers, vocabularies = [], onChange }) => {
  const { rows, sentenceFields } = latexLayout(options, layers);
  const set = (patch) =>
    onChange({
      ...options,
      rows,
      sentenceFields,
      ...patch,
    });
  return (
    <div className="flex flex-col gap-4">
      <OrderedList
        title="Example lines"
        items={rows}
        nameOf={rowName}
        scopeOf={(row) => SCOPE_LABEL[row.kind] ?? null}
        onChange={(next) => set({ rows: next })}
      />
      {sentenceFields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <OrderedList
            title="Sentence fields"
            items={sentenceFields}
            nameOf={(f) => f.name}
            onChange={(next) => set({ sentenceFields: next })}
          />
          <p className="text-xs text-muted-foreground">
            The first sentence field with a value is the free translation.
          </p>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t pt-3">
        <Toggle
          label="Document metadata"
          checked={options.includeHeader !== false}
          onChange={(v) => set({ includeHeader: v })}
        />
      </div>
      {(vocabularies.length > 0 || options.vocabulary) && (
        <VocabularyOptions
          choice={latexVocabulary(options, vocabularies)}
          onChange={(vocabulary) => set({ vocabulary })}
        />
      )}
    </div>
  );
};
