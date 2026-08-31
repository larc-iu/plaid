import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { elanLossSummary } from '@/export/elan';

// One checkbox group per discovered tier bucket (rendered only when the
// project actually has layers in that bucket).
const CheckGroup = ({ title, description, names, selected, onChange, disabled = false }) => {
  if (!names.length) return null;
  const has = (n) => selected.includes(n);
  const toggle = (n, on) => onChange(on ? [...selected, n] : selected.filter((x) => x !== n));
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{title}</Label>
      {description && <p className="-mt-1 text-xs text-muted-foreground">{description}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {names.map((n) => (
          <label
            key={n}
            className={`flex items-center gap-2 text-sm ${
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              checked={has(n)}
              disabled={disabled}
              onChange={(e) => toggle(n, e.target.checked)}
            />
            <span>{n}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

const Toggle = ({ label, description, checked, onChange }) => (
  <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
    <span className="min-w-0">
      <span>{label}</span>
      {description && <span className="block text-xs text-muted-foreground">{description}</span>}
    </span>
    <Switch checked={checked} onCheckedChange={onChange} />
  </label>
);

// Step 2 (.eaf): which tiers to emit, plus the three shape decisions. ELAN has
// a tier for everything IGT holds, so the only loss is what's left unselected.
// The summary states it before the export runs, the way the CLDF panel does.
export const ElanOptions = ({ options, layers, onChange }) => {
  const set = (patch) => onChange({ ...options, ...patch });
  const segmenting = options.segmentMorphemes !== false;
  const summary = elanLossSummary(layers, options);

  return (
    <div className="flex flex-col gap-4">
      <CheckGroup
        title="Orthographies"
        description="One Symbolic_Association tier per orthography, under Word."
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
        description={segmenting ? undefined : 'Unavailable while morpheme segmentation is off.'}
        names={layers.morphFields}
        selected={options.morphFields || []}
        onChange={(v) => set({ morphFields: v })}
        disabled={!segmenting}
      />
      <CheckGroup
        title="Sentence fields"
        description="One Symbolic_Association tier per field, under Sentence."
        names={layers.sentFields}
        selected={options.sentFields || []}
        onChange={(v) => set({ sentFields: v })}
      />

      <div className="flex flex-col gap-3 border-t pt-3">
        {layers.hasMorphemes && (
          <Toggle
            label="Segment words into morphemes"
            description="Adds a Morph tier beneath Word, subdivided symbolically."
            checked={segmenting}
            onChange={(v) => set({ segmentMorphemes: v })}
          />
        )}
        {layers.hasMorphemes && segmenting && (
          <Toggle
            label="Show affix markers on morphemes"
            description="Writes “-s” rather than “s”. Turn off for exact-form searching in ELAN."
            checked={options.affixMarkers !== false}
            onChange={(v) => set({ affixMarkers: v })}
          />
        )}
        <Toggle
          label="One tier set per speaker"
          description="Splits the tiers by the speaker on each time-aligned segment, suffixed “@Speaker”. Documents with no speakers get a single set either way."
          checked={options.perSpeaker !== false}
          onChange={(v) => set({ perSpeaker: v })}
        />
        <Toggle
          label="Include media files"
          description="Bundles the audio or video beside the .eaf so its media link resolves."
          checked={options.includeMedia !== false}
          onChange={(v) => set({ includeMedia: v })}
        />
      </div>

      <div className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
        {summary.tiers.length > 0 && (
          <p>
            <span className="font-medium text-foreground">Tiers: </span>
            {summary.tiers.join(', ')}
          </p>
        )}
        {summary.dropped.length > 0 && (
          <p>
            <span className="font-medium text-foreground">Not exported: </span>
            {summary.dropped.join(', ')}
          </p>
        )}
        <p>
          Sentences carry the time span of the alignment segments inside them. A sentence with no
          alignment is written unaligned, which ELAN can open and align.
        </p>
      </div>
    </div>
  );
};
