import { cn } from '@ui/lib/utils';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Switch } from '@ui/components/ui/switch';
import { Textarea } from '@ui/components/ui/textarea';

// Renders a service's declared parameter schema as a form. Each field reports
// edits via onChange(key, value); the parent owns the values and the validation
// `errors` (see useNlpService). Returns null when the service declares no
// parameters.
//
// The enum field is a NATIVE <select>, not the shared Radix one, on purpose.
// This form is rendered inside a popover on the annotation editor, and a Radix
// Select portals its list to <body>, which that popover reads as an outside
// click and closes on. A native select has no portal and no such conflict. When
// item 11 moves the whole service-run idiom into plaid-ui and the editor's
// popover goes with it, this can become the shared Select.
const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export function ServiceParamForm({ schema, values, onChange, errors = {}, disabled = false }) {
  if (!schema || schema.length === 0) return null;
  return (
    <div className="tw flex flex-col gap-3">
      {schema.map((param) => (
        <ParamField
          key={param.key}
          param={param}
          value={values?.[param.key]}
          error={errors?.[param.key]}
          onChange={(v) => onChange(param.key, v)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

const Field = ({ id, label, description, error, children }) => (
  <div className="flex flex-col gap-1.5">
    <Label htmlFor={id}>{label}</Label>
    {description && <p className="text-xs text-muted-foreground">{description}</p>}
    {children}
    {error && <p className="text-xs text-destructive">{error}</p>}
  </div>
);

function ParamField({ param, value, error, onChange, disabled }) {
  const id = `param-${param.key}`;
  const label = `${param.label}${param.required ? ' *' : ''}`;
  const options = param.options || [];

  switch (param.type) {
    case 'boolean':
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Switch id={id} checked={!!value} onCheckedChange={onChange} disabled={disabled} />
            <Label htmlFor={id}>{label}</Label>
          </div>
          {param.description && (
            <p className="text-xs text-muted-foreground">{param.description}</p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case 'number':
      return (
        <Field id={id} label={label} description={param.description} error={error}>
          <Input
            id={id}
            type="number"
            value={value ?? ''}
            min={param.min}
            max={param.max}
            step={param.step}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            disabled={disabled}
          />
        </Field>
      );

    case 'enum':
      return (
        <Field id={id} label={label} description={param.description} error={error}>
          <select
            id={id}
            className={cn(SELECT_CLASS, error && 'border-destructive')}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          >
            {value == null && <option value="" />}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      );

    // A checkbox list rather than a combobox: these lists are short, and every
    // option being visible at once is what the reader wants when picking
    // several. It also has no portal, for the reason above.
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      const toggle = (v) =>
        onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
      return (
        <div className="flex flex-col gap-1.5">
          <Label>{label}</Label>
          {param.description && (
            <p className="text-xs text-muted-foreground">{param.description}</p>
          )}
          <div className="flex flex-col gap-1 rounded-md border p-2">
            {options.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                  disabled={disabled}
                />
                {o.label}
              </label>
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );
    }

    case 'string':
    default:
      return (
        <Field id={id} label={label} description={param.description} error={error}>
          {param.multiline ? (
            <Textarea
              id={id}
              value={value ?? ''}
              placeholder={param.placeholder}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              disabled={disabled}
            />
          ) : (
            <Input
              id={id}
              value={value ?? ''}
              placeholder={param.placeholder}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
            />
          )}
        </Field>
      );
  }
}
