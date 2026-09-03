import { Switch } from '@/components/ui/switch';

// Step 2 (Plaid IGT JSON): the lossless archive has exactly one knob — media.
export const NativeOptions = ({ options, onChange }) => (
  <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">
      Plaid IGT JSON is a lossless archive: it always includes the project configuration, all
      vocabularies, and full document data (ids, offsets, metadata, provenance, time alignment),
      packaged as a .zip. Archives can be re-imported as new projects.
    </p>
    <p className="text-xs text-muted-foreground">
      Comments are included, and they carry their authors’ email addresses. On re-import the server
      re-stamps every comment with whoever ran the import, so each one keeps its original author and
      date as a quoted note at the top of its text. A historical export omits comments, which are
      not versioned.
    </p>
    <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
      <span>Embed media files (audio/video) in the archive</span>
      <Switch
        checked={options.includeMedia !== false}
        onCheckedChange={(v) => onChange({ ...options, includeMedia: v })}
      />
    </label>
    <p className="text-xs text-muted-foreground">
      Large media can make the export slow or exceed browser memory. Disable to produce a data-only
      archive (time-aligned segments are kept either way).
    </p>
  </div>
);
