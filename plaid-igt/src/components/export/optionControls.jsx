// The controls the export options panels share.
import { Label } from '@ui/components/ui/label';
import { Switch } from '@ui/components/ui/switch';

// One checkbox group per discovered tier bucket (rendered only when the
// project actually has layers in that bucket).
export const CheckGroup = ({ title, description, names, selected, onChange, disabled = false }) => {
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

export const Toggle = ({ label, description, checked, onChange }) => (
  <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
    <span className="min-w-0">
      <span>{label}</span>
      {description && <span className="block text-xs text-muted-foreground">{description}</span>}
    </span>
    <Switch checked={checked} onCheckedChange={onChange} />
  </label>
);
