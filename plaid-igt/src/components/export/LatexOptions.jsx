import { ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { Label } from '@ui/components/ui/label';
import { Toggle } from './PlainTextOptions.jsx';
import { latexLayout, ROW_KINDS } from '@/export/latexBook';

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

// Step 2 (LaTeX book): which lines each example shows and in what order, the
// sentence fields under it, and the metadata switch. Any change stores the
// whole order.
export const LatexOptions = ({ options, layers, onChange }) => {
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
    </div>
  );
};
