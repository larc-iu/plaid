import { Label } from '@ui/components/ui/label';
import { Input } from '@ui/components/ui/input';
import { Switch } from '@ui/components/ui/switch';
import { Textarea } from '@ui/components/ui/textarea';
import { Slider } from '@ui/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@ui/components/ui/select';

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
    <div
      className="flex flex-col gap-1.5"
      style={{ minWidth: param.type === 'number' && param.slider ? 260 : 180 }}
    >
      <Label htmlFor={id} className="flex items-baseline justify-between gap-3 text-xs">
        <span>
          {param.label}
          {param.required ? ' *' : ''}
        </span>
        {param.type === 'number' && param.slider && (
          <span className="tabular-nums text-muted-foreground">{value ?? param.default}</span>
        )}
      </Label>
      {control}
      {error ? (
        <p className="text-xs text-destructive" style={{ maxWidth: 260 }}>
          {error}
        </p>
      ) : param.description ? (
        <p className="text-xs text-muted-foreground" style={{ maxWidth: 260 }}>
          {param.description}
        </p>
      ) : null}
    </div>
  );
}

// Snap a dragged value onto the declared step, so 0.15000000000000002 never
// reaches a service or a localStorage cache.
function round(value, step) {
  const decimals = (String(step).split('.')[1] || '').length;
  return Number(value.toFixed(decimals));
}

function renderControl(id, param, value, onChange, disabled) {
  switch (param.type) {
    case 'boolean':
      return <Switch id={id} checked={!!value} onCheckedChange={onChange} disabled={disabled} />;
    case 'number':
      // A number with a range and `slider` is dragged, not typed: the value
      // reads out beside the label so the control still states where it sits.
      if (param.slider && Number.isFinite(param.min) && Number.isFinite(param.max)) {
        const step = param.step || 1;
        const current = Number.isFinite(value) ? value : (param.default ?? param.min);
        return (
          <Slider
            id={id}
            aria-label={param.label}
            value={[current]}
            min={param.min}
            max={param.max}
            step={step}
            disabled={disabled}
            onValueChange={([v]) => onChange(round(v, step))}
          />
        );
      }
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
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
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
