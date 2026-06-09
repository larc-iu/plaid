import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

// Renders a service's declared parameter schema as a form. Each field reports
// edits via onChange(key, value); the parent holds the values + validation
// `errors` (see useServiceParams). Returns null when the service declares no
// parameters.
export function ServiceParamForm({ schema, values, onChange, errors = {}, disabled = false }) {
  if (!schema || schema.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-4">
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

function ParamField({ param, value, error, onChange, disabled }) {
  const id = `svc-param-${param.key}`;
  const control = renderControl(id, param, value, onChange, disabled);
  return (
    <div className="flex flex-col gap-1.5" style={{ minWidth: 180 }}>
      <Label htmlFor={id} className="text-xs">
        {param.label}{param.required ? ' *' : ''}
      </Label>
      {control}
      {error ? (
        <p className="text-xs text-destructive" style={{ maxWidth: 260 }}>{error}</p>
      ) : param.description ? (
        <p className="text-xs text-muted-foreground" style={{ maxWidth: 260 }}>{param.description}</p>
      ) : null}
    </div>
  );
}

function renderControl(id, param, value, onChange, disabled) {
  switch (param.type) {
    case 'boolean':
      return (
        <Switch id={id} checked={!!value} onCheckedChange={onChange} disabled={disabled} />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          value={value ?? ''}
          min={param.min}
          max={param.max}
          step={param.step}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          style={{ width: 200 }}
        />
      );
    case 'enum':
      return (
        <Select value={value ?? ''} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} style={{ width: 200 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(param.options || []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'multiselect': {
      const selected = Array.isArray(value) ? value : [];
      const toggle = (optValue, on) =>
        onChange(on ? [...selected, optValue] : selected.filter((v) => v !== optValue));
      return (
        <div className="flex flex-col gap-1">
          {(param.options || []).map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm">
              <Switch
                checked={selected.includes(opt.value)}
                onCheckedChange={(on) => toggle(opt.value, on)}
                disabled={disabled}
              />
              {opt.label}
            </label>
          ))}
        </div>
      );
    }
    case 'string':
    default:
      if (param.multiline) {
        return (
          <Textarea
            id={id}
            value={value ?? ''}
            placeholder={param.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: 260 }}
          />
        );
      }
      return (
        <Input
          id={id}
          type="text"
          value={value ?? ''}
          placeholder={param.placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 200 }}
        />
      );
  }
}
