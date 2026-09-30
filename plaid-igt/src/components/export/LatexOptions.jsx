import { CheckGroup, Toggle } from './PlainTextOptions.jsx';

// Step 2 (LaTeX book): which lines each example shows, and the metadata switch.
export const LatexOptions = ({ options, layers, onChange }) => {
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
      {layers.sentFields.length > 0 && (
        <p className="text-xs text-muted-foreground">
          The first sentence field with a value is the free translation.
        </p>
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
