import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { buildDefaultValues, coerceParamValues } from '@larc-iu/plaid-client';

// Destructive per-run opt-ins that must NOT persist across dialog opens/sessions:
// they reset to their (safe, default-OFF) schema value every (re)init and are
// never written to localStorage, so a one-time enable can't silently re-arm and
// clobber human-verified work on a later "innocent" re-run. `overwrite` is the
// shared destructive flag across the tokenizer / ASR / FST services. A project
// default (config.serviceDefaults) is still honored — that's an explicit choice.
const NON_PERSISTENT_PARAMS = new Set(['overwrite']);

// Form state for one declared parameter schema. Seeds from the schema's
// defaults, overlaid with the project's default params for this method,
// overlaid with any cached values; persists edits in localStorage; exposes live
// validation `errors`, a `coerced()` to merge into the request payload, and a
// `reset()` back to the seeded state.
//
// The schema is whatever the selected METHOD declares — a service's
// `extras.parameters` or an app built-in's own schema — so a built-in with
// options (speech detection) runs through the same path as a service.
// `useServiceSpot` is the normal caller.
//
// The merge order, lowest first: the schema's own defaults, `seedParams`, the
// project's defaults for this method, the user's cached values. `seedParams` is
// what an app can answer from the project itself (UD seeds a parse service's
// `language` from the project's language). It sits lowest of the three because
// it is the broadest statement: an argument a maintainer set for this spot, or
// one this user last ran with, is the more specific answer.
//
//   schema:        the parameter descriptors (see plaid-client serviceSchema)
//   storageKey:    full localStorage key, or null to keep values in memory
//   seedParams:    app-supplied values under the project's, else null
//   defaultParams: project-level defaults for THIS method, else null
export function useServiceParams({ schema, storageKey, seedParams = null, defaultParams = null }) {
  const [values, setValues] = useState({});

  // Latest values, so setParam can persist without recreating on every change.
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // Read through refs, so what the callback CLOSES OVER is always current
  // while what it DEPENDS ON is the content below, not objects a caller
  // rebuilds every render.
  const seedRef = useRef(seedParams);
  seedRef.current = seedParams;
  const defaultRef = useRef(defaultParams);
  defaultRef.current = defaultParams;

  // A schema is stable for the life of a method, so seeding is keyed on the
  // storage key rather than on schema identity (re-discovery replaces a
  // service object without changing what it declares).
  //
  // It is keyed on what the two param sources SAY as well, because they do not
  // all arrive at once: discovery is one small GET and a project is not, so a
  // caller can have its storage key before it has anything to seed with. UD's
  // parse spot did, and opened on the schema's default language rather than
  // the project's, for anyone who had never touched the dialog.
  const seedSignature = JSON.stringify(seedParams ?? null);
  const defaultSignature = JSON.stringify(defaultParams ?? null);

  const seed = useCallback(
    ({ useCache = true } = {}) => {
      const defaults = buildDefaultValues(schema);
      const seeded = seedRef.current || {};
      const projectParams = defaultRef.current || {};
      let cached = {};
      if (useCache && storageKey) {
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) cached = JSON.parse(raw) || {};
        } catch {
          /* ignore malformed cache */
        }
      }
      const merged = { ...defaults };
      for (const k of Object.keys(defaults)) {
        if (seeded[k] !== undefined) merged[k] = seeded[k];
        if (projectParams[k] !== undefined) merged[k] = projectParams[k];
        // Destructive opt-ins are never re-seeded from the cache — they reset
        // to the schema/project default on each open (NON_PERSISTENT_PARAMS).
        if (cached[k] !== undefined && !NON_PERSISTENT_PARAMS.has(k)) merged[k] = cached[k];
      }
      return merged;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, seedSignature, defaultSignature],
  );

  useEffect(() => {
    setValues(schema.length ? seed() : {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const persist = useCallback(
    (next) => {
      if (!storageKey) return;
      try {
        // Persist everything EXCEPT destructive opt-ins, so they can't re-arm
        // on the next open. They still toggle live within the open dialog.
        const toPersist = { ...next };
        for (const k of NON_PERSISTENT_PARAMS) delete toPersist[k];
        localStorage.setItem(storageKey, JSON.stringify(toPersist));
      } catch {
        /* ignore quota / serialization errors */
      }
    },
    [storageKey],
  );

  const setParam = useCallback(
    (key, value) => {
      const next = { ...valuesRef.current, [key]: value };
      persist(next);
      setValues(next);
    },
    [persist],
  );

  // Back to the schema and project defaults, forgetting this user's cache.
  const reset = useCallback(() => {
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* nothing to undo */
      }
    }
    setValues(seed({ useCache: false }));
  }, [seed, storageKey]);

  // Live coercion: cleaned values + validation errors keyed by param key.
  const { values: coercedValues, errors } = useMemo(
    () => coerceParamValues(schema, values),
    [schema, values],
  );

  // True once the form differs from what a fresh seed would produce, which is
  // what decides whether a Reset control is worth showing.
  const isDirty = useMemo(() => {
    if (!schema.length) return false;
    const fresh = seed({ useCache: false });
    return Object.keys(fresh).some((k) => JSON.stringify(fresh[k]) !== JSON.stringify(values[k]));
  }, [schema, seed, values]);

  // Cleaned values ready to merge into a request payload.
  const coerced = useCallback(() => coercedValues, [coercedValues]);

  // `values` stays RAW: the form binds to it, and coercing mid-keystroke would
  // clamp a half-typed number under the cursor. `coerced()` is the payload.
  return { schema, values, setParam, reset, isDirty, coerced, coercedValues, errors };
}
