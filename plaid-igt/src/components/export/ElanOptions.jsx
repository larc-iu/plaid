import { elanLossSummary } from '@/export/elan';
import { CheckGroup, Toggle } from './optionControls.jsx';
import { t, tx } from '@ui/lib/i18n.js';

// Step 2 (.eaf): which tiers to emit, plus the three shape decisions. ELAN has
// a tier for everything IGT holds, so the only loss is what's left unselected.
// The summary states it before the export runs, the way the CLDF panel does.
const strong = (c) => <span className="font-medium text-foreground">{c}</span>;

export const ElanOptions = ({ options, layers, onChange }) => {
  const set = (patch) => onChange({ ...options, ...patch });
  const segmenting = options.segmentMorphemes !== false;
  const summary = elanLossSummary(layers, options);

  return (
    <div className="flex flex-col gap-4">
      <CheckGroup
        title={t('Orthographies')}
        description={t('One Symbolic_Association tier per orthography, under Word.')}
        names={layers.orthographies}
        selected={options.orthographies || []}
        onChange={(v) => set({ orthographies: v })}
      />
      <CheckGroup
        title={t('Word fields')}
        names={layers.wordFields}
        selected={options.wordFields || []}
        onChange={(v) => set({ wordFields: v })}
      />
      <CheckGroup
        title={t('Morpheme fields')}
        description={segmenting ? undefined : t('Unavailable while morpheme segmentation is off.')}
        names={layers.morphFields}
        selected={options.morphFields || []}
        onChange={(v) => set({ morphFields: v })}
        disabled={!segmenting}
      />
      <CheckGroup
        title={t('Sentence fields')}
        description={t('One Symbolic_Association tier per field, under Sentence.')}
        names={layers.sentFields}
        selected={options.sentFields || []}
        onChange={(v) => set({ sentFields: v })}
      />

      <div className="flex flex-col gap-3 border-t pt-3">
        {layers.hasMorphemes && (
          <Toggle
            label={t('Segment words into morphemes')}
            description={t('Adds a Morph tier beneath Word, subdivided symbolically.')}
            checked={segmenting}
            onChange={(v) => set({ segmentMorphemes: v })}
          />
        )}
        {layers.hasMorphemes && segmenting && (
          <Toggle
            label={t('Show affix markers on morphemes')}
            description={t(
              'Writes “-s” rather than “s”. Turn off for exact-form searching in ELAN.',
            )}
            checked={options.affixMarkers !== false}
            onChange={(v) => set({ affixMarkers: v })}
          />
        )}
        <Toggle
          label={t('One tier set per speaker')}
          description={t(
            'Splits the tiers by the speaker on each time-aligned segment, suffixed “@Speaker”. Documents with no speakers get a single set either way.',
          )}
          checked={options.perSpeaker !== false}
          onChange={(v) => set({ perSpeaker: v })}
        />
        <Toggle
          label={t('Include media files')}
          description={t('Bundles the audio or video beside the .eaf so its media link resolves.')}
          checked={options.includeMedia !== false}
          onChange={(v) => set({ includeMedia: v })}
        />
      </div>

      <div className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
        {summary.tiers.length > 0 && (
          <p>{tx('<b>Tiers:</b> {tiers}', { tiers: summary.tiers.join(', '), b: strong })}</p>
        )}
        {summary.dropped.length > 0 && (
          <p>
            {tx('<b>Not exported:</b> {tiers}', { tiers: summary.dropped.join(', '), b: strong })}
          </p>
        )}
        <p>
          {t(
            'Sentences carry the time span of the alignment segments inside them. A sentence with no alignment is written unaligned, which ELAN can open and align.',
          )}
        </p>
      </div>
    </div>
  );
};
