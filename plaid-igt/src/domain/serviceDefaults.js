// Project-level service defaults: which service (or app built-in) each
// integration spot should use by default, plus default parameter values.
// Stored in project config under the app namespace:
//
//   config.igt.serviceDefaults = {
//     [task]: { service: { serviceId } | { builtin }, params: { ... } }
//   }
//
// Maintainers edit this on the Services settings tab; editors read it to seed
// their selection. Per-user localStorage still overrides on top (resolution
// order: valid localStorage -> project default -> spot built-in -> first
// online service).
//
// Selections are encoded as strings — shared by localStorage values and
// select option values:
//   'service:<serviceId>'  — an external service
//   'builtin:<name>'       — an app built-in implementation

import { IGT_NAMESPACE } from './igtConfig';

// Built-in implementation names (the <name> in 'builtin:<name>').
export const BUILTIN_TOKENIZE_RULE_BASED = 'rule-based-punctuation';
export const BUILTIN_LINK_PRECEDENT = 'precedent';

export const encodeServiceSelection = (serviceId) => `service:${serviceId}`;
export const encodeBuiltinSelection = (name) => `builtin:${name}`;

// 'service:x' / 'builtin:y' -> {kind, id}; null for anything else.
export const decodeSelection = (value) => {
  if (typeof value !== 'string') return null;
  if (value.startsWith('service:')) return { kind: 'service', id: value.slice('service:'.length) };
  if (value.startsWith('builtin:')) return { kind: 'builtin', id: value.slice('builtin:'.length) };
  return null;
};

// The config's {service: {serviceId}|{builtin}} shape <-> selection string.
export const selectionFromConfig = (entry) => {
  const svc = entry?.service;
  if (svc?.serviceId) return encodeServiceSelection(svc.serviceId);
  if (svc?.builtin) return encodeBuiltinSelection(svc.builtin);
  return null;
};

export const selectionToConfig = (selection) => {
  const decoded = decodeSelection(selection);
  if (!decoded) return null;
  return decoded.kind === 'service' ? { serviceId: decoded.id } : { builtin: decoded.id };
};

// The project's default entry for a spot: {service, params} or null.
export const readSpotDefault = (project, task) =>
  project?.config?.[IGT_NAMESPACE]?.serviceDefaults?.[task] || null;

// Pick the selection an editor should start from. `services` are the spot's
// task-matching services; only ONLINE ones are runnable. `builtins` is a list
// of built-in names (always runnable). Returns a selection string or null.
export const resolveInitialSelection = ({ services = [], builtins = [], cached, projectDefault }) => {
  const valid = (selection) => {
    const decoded = decodeSelection(selection);
    if (!decoded) return false;
    if (decoded.kind === 'builtin') return builtins.includes(decoded.id);
    return services.some((s) => s.serviceId === decoded.id && s.online !== false);
  };
  if (valid(cached)) return cached;
  const dflt = selectionFromConfig(projectDefault);
  if (valid(dflt)) return dflt;
  if (builtins.length) return encodeBuiltinSelection(builtins[0]);
  const firstOnline = services.find((s) => s.online !== false);
  return firstOnline ? encodeServiceSelection(firstOnline.serviceId) : null;
};
