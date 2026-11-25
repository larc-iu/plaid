import { Label } from '@ui/components/ui/label';
import { CheckGroup, Toggle } from './optionControls.jsx';

// Step 2 (Praat TextGrid): which lines become tiers. A TextGrid holds only
// what has a time, so every line is a tier of sentence intervals, and the
// note at the foot says what that leaves out.
export const TextGridOptions = ({ options, layers, onChange }) => {
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
      <div className="flex flex-col gap-3 border-t pt-3">
        {layers.hasMorphemes && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="textgrid-word-line">Word tiers</Label>
            <select
              id="textgrid-word-line"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={options.wordLine || 'segmented'}
              onChange={(e) => set({ wordLine: e.target.value })}
            >
              <option value="both">Words and Morphemes</option>
              <option value="surface">Words only, as written</option>
              <option value="segmented">Morphemes only</option>
            </select>
          </div>
        )}
        <Toggle
          label="One tier set per speaker"
          description="Splits the tiers by the speaker on each time-aligned segment, suffixed “@Speaker”. Documents with no speakers get a single set either way."
          checked={options.perSpeaker !== false}
          onChange={(v) => set({ perSpeaker: v })}
        />
        <Toggle
          label="Include media files"
          description="Bundles the recording, so Praat can open it with the TextGrid. It also lets the TextGrid cover the whole recording."
          checked={options.includeMedia !== false}
          onChange={(v) => set({ includeMedia: v })}
        />
      </div>
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Every tier holds one interval per sentence, timed by the segments inside it. Words and
        morphemes have no times of their own, so each word line is written whole in its
        sentence&apos;s interval. A sentence with no time-aligned segment is left out.
      </p>
    </div>
  );
};
