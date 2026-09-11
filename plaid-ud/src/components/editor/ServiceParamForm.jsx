import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { Switch } from '@ui/components/ui/switch';
import { Textarea } from '@ui/components/ui/textarea';

// Renders a service's declared parameter schema as a form. Each field reports
// edits via onChange(key, value); the parent owns the values and the validation
// `errors` (see useNlpService). Returns null when the service declares no
// parameters.

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
          <Select value={value ?? undefined} onValueChange={onChange} disabled={disabled}>
            <SelectTrigger id={id} className={error ? 'border-destructive' : undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      );

    // A checkbox list rather than a combobox: these lists are short, and every
    // option being visible at once is what the reader wants when picking
    // several.
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
