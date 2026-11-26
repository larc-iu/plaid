import { Switch } from '@ui/components/ui/switch';
import { t } from '@ui/lib/i18n.js';

// Step 2 (Plaid IGT JSON): the lossless archive has exactly one knob — media.
export const NativeOptions = ({ options, onChange }) => (
  <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">
      {t(
        'Plaid IGT JSON is a lossless archive: it always includes the project configuration, all vocabularies, and full document data (ids, offsets, metadata, provenance, time alignment), packaged as a .zip. Archives can be re-imported as new projects.',
      )}
    </p>
    <p className="text-xs text-muted-foreground">
      {t(
        'Comments are included, with their authors’ email addresses. On import, each comment names its original author and date at the top of its text. An export of a past state has no comments.',
      )}
    </p>
    <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
      <span>{t('Embed media files (audio/video) in the archive')}</span>
      <Switch
        checked={options.includeMedia !== false}
        onCheckedChange={(v) => onChange({ ...options, includeMedia: v })}
      />
    </label>
    <p className="text-xs text-muted-foreground">
      {t(
        'Large media can make the export slow or fail. Untick to leave the media out. Time-aligned segments are exported either way.',
      )}
    </p>
  </div>
);
