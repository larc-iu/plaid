import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getParamSchema, buildDefaultValues, coerceParamValues } from '@larc-iu/plaid-client';

// Per-integration-point hook for a selected service's user-controllable
// arguments. Seeds form values from the service's declared parameter schema
// (defaults, overlaid with the project's default params for this service if
// any, overlaid with any cached values), persists edits per service in
// localStorage, exposes live validation `errors`, and a `coerced()` to merge
// into the request payload.
//
//   selectedService: the chosen DiscoveredService (or null for built-in/none)
//   storagePrefix:   localStorage key prefix; the serviceId is appended
//   defaultParams:   project-level default values (config.<ns>.serviceDefaults
//                    [task].params) — only applied when they belong to THIS
//                    service; the caller passes null otherwise
export function useServiceParams(selectedService, storagePrefix, defaultParams = null) {
  const serviceId = selectedService?.serviceId || null;
  const schema = useMemo(() => getParamSchema(selectedService), [selectedService]);
  const [values, setValues] = useState({});

  // Latest values, so setParam can persist without recreating on every change.
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // (Re)initialize when the selected service changes: schema defaults,
  // overlaid with project default params, overlaid with cached values — for
  // keys still in the schema. Keyed on serviceId only — a service's schema is
  // stable within a session, so we don't re-seed on every re-discovery (which
  // replaces the service object identity but not its schema).
  useEffect(() => {
    if (!serviceId) {
      setValues({});
      return;
    }
    const defaults = buildDefaultValues(schema);
    const projectParams = defaultParams || {};
    let cached = {};
    try {
      const raw = localStorage.getItem(`${storagePrefix}${serviceId}`);
      if (raw) cached = JSON.parse(raw) || {};
    } catch {
      /* ignore malformed cache */
    }
    const merged = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (projectParams[k] !== undefined) merged[k] = projectParams[k];
      if (cached[k] !== undefined) merged[k] = cached[k];
    }
    setValues(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, storagePrefix]);

  const setParam = useCallback((key, value) => {
    const next = { ...valuesRef.current, [key]: value };
    if (serviceId) {
      try {
        localStorage.setItem(`${storagePrefix}${serviceId}`, JSON.stringify(next));
      } catch {
        /* ignore quota / serialization errors */
      }
    }
    setValues(next);
  }, [serviceId, storagePrefix]);

  // Live coercion: cleaned values + validation errors keyed by param key.
  const { values: coercedValues, errors } = useMemo(
    () => coerceParamValues(schema, values),
    [schema, values],
  );

  // Cleaned values ready to merge into a request payload.
  const coerced = useCallback(() => coercedValues, [coercedValues]);

  return { schema, values, setParam, coerced, errors };
}
