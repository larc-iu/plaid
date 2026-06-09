/**
 * Service self-description: tasks, summary, and a parameter schema.
 *
 * The service framework's transport carries an opaque `extras` JSON map on every
 * registered service (see services.js). This module standardizes what a service
 * advertises in that map so apps can, at a fixed integration point (a "task"
 * like tokenize / parse / transcribe):
 *
 *   1. SELECT one of several services that serve the task,
 *   2. let the user SPECIFY arguments the service declares, and
 *   3. show the user a service-provided SUMMARY.
 *
 * Shape of a service's `extras` (camelCase here; Python services author the
 * snake_case equivalent and the client transform converts it — see the Plaid
 * manual, "Describing a service"):
 *
 *   {
 *     schemaVersion: 1,
 *     tasks: ["tokenize"],              // controlled vocab; REPLACES tok:/asr: id prefixes
 *     summary: "## markdown …",         // rich human description
 *     parameters: [                     // ordered; rendered into a form
 *       { key, label, type, description?, default?, required?,
 *         options?: [{value, label}],   // enum / multiselect
 *         min?, max?, step?,            // number
 *         placeholder?, multiline? }    // string
 *     ]
 *   }
 *
 * A parameter's `key` is a string VALUE, so it passes over the wire verbatim;
 * the UI sends `{ [param.key]: value }` in the request data. Declare each `key`
 * in your service's own convention (Python: snake_case; JS: camelCase) and read
 * it back under that same key — request data is recased symmetrically, so a
 * snake_case key round-trips unchanged to a JS UI and back.
 */

/** The controlled task vocabulary — the fixed integration-point goals. */
export const TASKS = Object.freeze({
  TOKENIZE: 'tokenize',
  PARSE: 'parse',
  TRANSCRIBE: 'transcribe',
});

/**
 * Legacy id-prefix → task map, for services that have not yet migrated to a
 * declared `tasks` array. Drop once all services advertise `tasks`.
 */
const LEGACY_TASK_PREFIXES = Object.freeze({
  [TASKS.TOKENIZE]: 'tok:',
  [TASKS.TRANSCRIBE]: 'asr:',
});

/**
 * Does `service` serve `task`? Prefers the declared `extras.tasks` array; falls
 * back to the legacy id-prefix convention for un-migrated services.
 * @param {{serviceId?: string, extras?: {tasks?: string[]}}} service
 * @param {string} task one of TASKS
 * @returns {boolean}
 */
export function servesTask(service, task) {
  const declared = service?.extras?.tasks;
  if (Array.isArray(declared) && declared.length) {
    return declared.includes(task);
  }
  const prefix = LEGACY_TASK_PREFIXES[task];
  return !!prefix && typeof service?.serviceId === 'string' && service.serviceId.startsWith(prefix);
}

/**
 * The discovered services that serve `task`.
 * @param {Array} services result of client.messages.discoverServices()
 * @param {string} task one of TASKS
 * @returns {Array}
 */
export function filterServicesByTask(services, task) {
  return (services || []).filter((s) => servesTask(s, task));
}

/**
 * The parameter schema a service declares (ordered array), or [].
 * @param {{extras?: {parameters?: Array}}} service
 * @returns {Array}
 */
export function getParamSchema(service) {
  const params = service?.extras?.parameters;
  return Array.isArray(params) ? params : [];
}

/**
 * A service's human summary: the rich `extras.summary`, else the short
 * `description`, else ''.
 * @param {{description?: string, extras?: {summary?: string}}} service
 * @returns {string}
 */
export function getServiceSummary(service) {
  return service?.extras?.summary || service?.description || '';
}

/** Valid option values for an enum/multiselect param. */
function optionValues(param) {
  return Array.isArray(param?.options) ? param.options.map((o) => o.value) : [];
}

/**
 * A single parameter's default, honoring its declared `default` then falling
 * back per type. For enum/multiselect the declared default is validated against
 * `options` (an out-of-range declared default never escapes).
 */
function defaultForParam(param) {
  const opts = optionValues(param);
  if (param.type === 'enum') {
    if (param.default != null && opts.includes(param.default)) return param.default;
    return opts[0] ?? '';
  }
  if (param.type === 'multiselect') {
    const arr = Array.isArray(param.default) ? param.default : [];
    return opts.length ? arr.filter((x) => opts.includes(x)) : arr;
  }
  if (param.default !== undefined && param.default !== null) return param.default;
  switch (param.type) {
    case 'number': return typeof param.min === 'number' ? param.min : 0;
    case 'boolean': return false;
    case 'string':
    default: return '';
  }
}

/**
 * Default values keyed by param key — the initial form state.
 * @param {Array} schema getParamSchema(service)
 * @returns {Object} { [key]: defaultValue }
 */
export function buildDefaultValues(schema) {
  const out = {};
  for (const param of schema || []) {
    if (!param || !param.key) continue;
    out[param.key] = defaultForParam(param);
  }
  return out;
}

/**
 * Coerce/validate raw form values against the schema. Returns the cleaned
 * values (keyed by param key, ready to merge into the request payload) plus any
 * validation errors keyed by param key. Unknown keys in `raw` are dropped.
 * @param {Array} schema getParamSchema(service)
 * @param {Object} raw current form values
 * @returns {{values: Object, errors: Object}}
 */
export function coerceParamValues(schema, raw) {
  const values = {};
  const errors = {};
  const src = raw || {};
  for (const param of schema || []) {
    if (!param || !param.key) continue;
    const k = param.key;
    let v = src[k];
    if (v === undefined) v = defaultForParam(param);

    switch (param.type) {
      case 'number': {
        // Blank / nullish counts as "missing" → the param's default (matches the
        // Python client, where float('') raises and falls back to the default).
        let n;
        if (v === '' || v == null || (typeof v === 'string' && v.trim() === '')) {
          n = defaultForParam(param);
        } else {
          n = typeof v === 'number' ? v : Number(v);
          if (Number.isNaN(n)) n = defaultForParam(param);
        }
        if (typeof param.min === 'number') n = Math.max(param.min, n);
        if (typeof param.max === 'number') n = Math.min(param.max, n);
        v = n;
        break;
      }
      case 'boolean':
        v = v === true || v === 'true';
        break;
      case 'enum': {
        const opts = optionValues(param);
        if (opts.length && !opts.includes(v)) v = defaultForParam(param);
        break;
      }
      case 'multiselect': {
        const opts = optionValues(param);
        const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
        v = opts.length ? arr.filter((x) => opts.includes(x)) : arr;
        break;
      }
      case 'string':
      default:
        v = v == null ? '' : String(v);
        break;
    }

    if (param.required) {
      const empty = v === '' || v == null || (Array.isArray(v) && v.length === 0);
      if (empty) errors[k] = `${param.label || k} is required`;
    }
    values[k] = v;
  }
  return { values, errors };
}
