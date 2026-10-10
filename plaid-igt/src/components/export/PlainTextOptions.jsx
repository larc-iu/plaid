import { Label } from '@ui/components/ui/label';
import { AlertTriangle } from 'lucide-react';
import { breaksMorphemeAlignment, wordLineOf } from '@/export/plainTextDoc';
import { CheckGroup, Toggle } from './optionControls.jsx';

// Step 2 (plain text): which tiers to include + layout switches.
export const PlainTextOptions = ({ options, layers, onChange }) => {
  const set = (patch) => onChange({ ...options, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <CheckGroup
        title="Orthographies"
        names={layers.orthographies}
        selected={options.orthographies || []}
        onChange={(v) => set({ orthographies: v })}
      />
      <CheckGroup
        title="Word fields"
        names={layers.wordFields}
        selected={options.wordFields || []}
        onChange={(v) => set({ wordFields: v })}
      />
      <CheckGroup
        title="Morpheme fields"
        names={layers.morphFields}
        selected={options.morphFields || []}
        onChange={(v) => set({ morphFields: v })}
      />
      <CheckGroup
        title="Sentence fields"
        names={layers.sentFields}
        selected={options.sentFields || []}
        onChange={(v) => set({ sentFields: v })}
      />
      <div className="flex flex-col gap-2 border-t pt-3">
        {layers.hasMorphemes && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plaintext-word-line">Word line</Label>
            <select
              id="plaintext-word-line"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={wordLineOf(options)}
              onChange={(e) => set({ wordLine: e.target.value })}
            >
              <option value="segmented">Segmented into morphemes</option>
              <option value="surface">As written</option>
              <option value="both">Both, as written above segmented</option>
            </select>
            {breaksMorphemeAlignment(options) && (
              <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>
                  The gloss line is segmented and this word line is not, so the hyphens on the two
                  lines will not correspond. Choose Segmented or Both.
                </span>
              </p>
            )}
          </div>
        )}
        <Toggle
          label="Number sentences"
          checked={options.numberSentences !== false}
          onChange={(v) => set({ numberSentences: v })}
        />
        <Toggle
          label="Document header (name + metadata)"
          checked={options.includeHeader !== false}
          onChange={(v) => set({ includeHeader: v })}
        />
      </div>
    </div>
  );
};
