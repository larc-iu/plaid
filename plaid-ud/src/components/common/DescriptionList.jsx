import { Input } from '@ui/components/ui/input';
import { t } from '@ui/lib/i18n.js';

// The one-line definition shown beside each value while picking one.
//
// Rendered from the VOCABULARY, not from the stored descriptions: a definition
// for a value the project removed helps nobody, and a value added without one
// should show an empty box asking for it rather than not appear.
export const DescriptionList = ({ values, descriptions, onChange, disabled }) => {
  if (!values?.length) {
    return (
      <p className="text-sm text-muted-foreground">{t('Add values above to describe them.')}</p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((value) => (
        <div key={value} className="flex items-center gap-2">
          <code className="w-28 shrink-0 truncate text-xs" title={value}>
            {value}
          </code>
          <Input
            className="h-8 text-sm"
            value={descriptions?.[value] || ''}
            disabled={disabled}
            aria-label={t('{value} description', { value })}
            placeholder={t('What it is for')}
            onChange={(e) => onChange(value, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
};
