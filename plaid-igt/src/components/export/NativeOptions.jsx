import { Switch } from '@/components/ui/switch';

// Step 2 (Plaid IGT JSON): the lossless archive has exactly one knob — media.
export const NativeOptions = ({ options, onChange }) => (
  <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">
      Plaid IGT JSON is a lossless archive: it always includes the project
      configuration, all vocabularies, and full document data (ids, offsets,
      metadata, provenance, time alignment), packaged as a .zip. See{' '}
      <code className="text-xs">docs/native-format.md</code> for the format
      specification.
    </p>
    <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
      <span>Embed media files (audio/video) in the archive</span>
      <Switch
        checked={options.includeMedia !== false}
        onCheckedChange={(v) => onChange({ ...options, includeMedia: v })}
      />
    </label>
    <p className="text-xs text-muted-foreground">
      Large media can make the export slow or exceed browser memory — disable
      to produce a data-only archive (time alignments are kept either way).
    </p>
  </div>
);
