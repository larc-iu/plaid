import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getParamSchema, buildDefaultValues, coerceParamValues } from '@larc-iu/plaid-client';

// Destructive per-run opt-ins that must NOT persist across dialog opens/sessions:
// they reset to their (safe, default-OFF) schema value every (re)init and are
// never written to localStorage, so a one-time enable can't silently re-arm and
// clobber human-verified work on a later "innocent" re-run. `overwrite` is the
// shared destructive flag across the tokenizer / ASR / FST services. A project
// default (config.serviceDefaults) is still honored — that's an explicit choice.
const NON_PERSISTENT_PARAMS = new Set(['overwrite']);

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
      // Destructive opt-ins are never re-seeded from the cache — they reset to
      // the schema/project default on each open (see NON_PERSISTENT_PARAMS).
      if (cached[k] !== undefined && !NON_PERSISTENT_PARAMS.has(k)) merged[k] = cached[k];
    }
    setValues(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, storagePrefix]);

  const setParam = useCallback((key, value) => {
    const next = { ...valuesRef.current, [key]: value };
    if (serviceId) {
      try {
        // Persist everything EXCEPT destructive opt-ins, so they can't re-arm
        // on the next open. They still toggle live within the open dialog.
        const toPersist = { ...next };
        for (const k of NON_PERSISTENT_PARAMS) delete toPersist[k];
        localStorage.setItem(`${storagePrefix}${serviceId}`, JSON.stringify(toPersist));
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
