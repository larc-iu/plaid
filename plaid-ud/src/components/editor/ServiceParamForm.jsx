import { Stack, Select, NumberInput, Switch, MultiSelect, TextInput, Textarea } from '@mantine/core';

// Renders a service's declared parameter schema as a Mantine form. Each field
// reports edits via onChange(key, value); the parent owns the values + validation
// `errors` (see useNlpService). Returns null when the service declares no
// parameters.
export function ServiceParamForm({ schema, values, onChange, errors = {}, disabled = false }) {
  if (!schema || schema.length === 0) return null;
  return (
    <Stack gap="sm">
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
    </Stack>
  );
}

function ParamField({ param, value, error, onChange, disabled }) {
  const label = `${param.label}${param.required ? ' *' : ''}`;
  const options = (param.options || []).map((o) => ({ value: o.value, label: o.label }));
  switch (param.type) {
    case 'boolean':
      return (
        <Switch
          label={label}
          description={param.description}
          error={error}
          checked={!!value}
          onChange={(e) => onChange(e.currentTarget.checked)}
          disabled={disabled}
        />
      );
    case 'number':
      return (
        <NumberInput
          label={label}
          description={param.description}
          error={error}
          value={value ?? ''}
          min={param.min}
          max={param.max}
          step={param.step}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'enum':
      return (
        <Select
          label={label}
          description={param.description}
          error={error}
          data={options}
          value={value ?? null}
          onChange={(v) => onChange(v)}
          allowDeselect={false}
          disabled={disabled}
        />
      );
    case 'multiselect':
      return (
        <MultiSelect
          label={label}
          description={param.description}
          error={error}
          data={options}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'string':
    default:
      return param.multiline ? (
        <Textarea
          label={label}
          description={param.description}
          error={error}
          value={value ?? ''}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.currentTarget.value)}
          autosize
          minRows={2}
          disabled={disabled}
        />
      ) : (
        <TextInput
          label={label}
          description={param.description}
          error={error}
          value={value ?? ''}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.currentTarget.value)}
          disabled={disabled}
        />
      );
  }
}
