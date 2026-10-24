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
 *     tasks: ["tokenize"],              // controlled vocab (TASKS)
 *     summary: "## markdown …",         // rich human description
 *     parameters: [                     // ordered; rendered into a form
 *       { key, label, type, description?, default?, required?,
 *         options?: [{value, label}],   // enum / multiselect
 *         min?, max?, step?, slider?,   // number (slider: drag, don't type)
 *         placeholder?, multiline?,     // string
 *         scope?, role? }               // field: 'Sentence' | 'Word' | 'Morpheme'
 *     ]
 *   }
 *
 * A `field` parameter names one of the project's annotation fields at its
 * `scope`. A UI that knows the project offers those fields to choose from; to
 * everything here, and to a UI that does not, it is a string. Its optional
 * `role` names a lexicon role ("gloss") or, at Sentence scope, a sentence
 * field's role ("translation", "literalTranslation", "note"): a UI that knows
 * the project fills the parameter with the one field at `scope` whose stored
 * Lexicon field holds that role, or whose stored role it is. A field is never
 * chosen by its name.
 *
 * A parameter's `key` is a string VALUE, so it passes over the wire verbatim;
 * the UI sends `{ [param.key]: value }` in the request data. Declare each `key`
 * in your service's own convention (Python: snake_case; JS: camelCase) and read
 * it back under that same key — request data is recased symmetrically, so a
 * snake_case key round-trips unchanged to a JS UI and back.
 */

/**
 * The controlled task vocabulary — the fixed integration-point goals.
 *
 * Whatever the task, a service should stamp everything it creates with the
 * provenance convention (see ./provenance.js: stampInferred(serviceSource(id)))
 * so UIs can distinguish machine output until a human verifies it, and should
 * honor the write contract: never destroy human-made or verified material
 * without an explicit `overwrite` parameter. See the manual, "Provenance".
 */
export const TASKS = Object.freeze({
  TOKENIZE: "tokenize",
  PARSE: "parse",
  TRANSCRIBE: "transcribe",
  /** Create vocab links for unlinked tokens. */
  LINK_VOCAB: "link-vocab",
  /** Propose an interlinear analysis (morpheme segmentation + glosses) for words. */
  ANALYZE: "analyze",
  /**
   * Draft a meaning representation graph over the sentences of a document,
   * for correction by hand. The request names a `scope` ('document' or
   * 'sentence'), a `sentence` number when the scope is one sentence, and
   * `overwrite`. See plaid-umr's drafting services.
   *
   * Apart from `analyze` on purpose. A task is the CONTRACT a spot offers a
   * service against, and these two share almost none of it: an analyze
   * request names the three token layers plus the language and metalanguage,
   * and writes morphemes and glosses. Both claimed `analyze` for
   * a while, so every app offering an analyze spot offered the other app's
   * services, which could not answer the request they would have been given.
   */
  DRAFT_GRAPH: "draft-graph",
  /** Propose a free translation for each sentence. */
  TRANSLATE: "translate",
  /**
   * Propose time-aligned speech regions for a recording.
   *
   * The odd one out: a detect-speech service RETURNS its regions and writes
   * nothing, because a time-aligned segment is a stretch of the baseline and
   * cannot exist without text. The response carries
   * `{segments: [{timeBegin, timeEnd, speaker?}]}` (seconds), and the app
   * holds them as proposals until a person types into one.
   */
  DETECT_SPEECH: "detect-speech",
  /** A conversational assistant over a project (chat turns; see plaid-agent). */
  ASSIST: "assist",
  /**
   * Score one document's annotation against another document's of the same
   * text (two annotators' copies), writing a report on the scored document's
   * metadata and never an annotation. The request names the other document
   * as `against`. See plaid-umr's AnCast service.
   */
  COMPARE: "compare",
});

/**
 * One choice for an `enum` or `multiselect` service parameter.
 * @typedef {{value: string, label: string}} ServiceParamOption
 */

/**
 * A single user-controllable argument a service advertises.
 * @typedef {object} ServiceParam
 * @property {string} key Key the value is sent under in the request payload.
 * @property {string} label
 * @property {"string" | "number" | "boolean" | "enum" | "multiselect" | "field"} type
 * @property {string} [description]
 * @property {any} [default]
 * @property {boolean} [required]
 * @property {ServiceParamOption[]} [options] Required for `enum` and `multiselect`.
 * @property {number} [min] `number` only.
 * @property {number} [max] `number` only.
 * @property {number} [step] `number` only.
 * @property {boolean} [slider] `number` only: render as a slider to drag
 *   rather than a box to type in.
 * @property {string} [placeholder] `string` only.
 * @property {boolean} [multiline] `string` only.
 * @property {"Sentence" | "Word" | "Morpheme"} [scope] `field` only: the
 *   scope of the project's annotation fields the value names one of. A
 *   `field` value is a string everywhere else.
 * @property {string} [role] `field` only: the lexicon role whose paired field,
 *   or the sentence role whose field, fills the parameter when nothing else
 *   does.
 */

/**
 * A service's standardized self-description (lives in `extras`).
 * @typedef {object} ServiceExtras
 * @property {number} [schemaVersion]
 * @property {string[]} [tasks] Tasks this service serves, from the TASKS vocabulary.
 * @property {string} [summary] Rich human description (Markdown), beyond the
 *   short `description`.
 * @property {ServiceParam[]} [parameters] Ordered parameter schema, rendered
 *   into a form by the UI.
 */

/**
 * What a service says about itself when it registers.
 * @typedef {object} ServiceInfo
 * @property {string} serviceId
 * @property {string} serviceName
 * @property {string} description
 * @property {ServiceExtras & Record<string, any>} [extras]
 */

/**
 * A service as `messages.discoverServices` lists it.
 * @typedef {object} DiscoveredService
 * @property {string} serviceId
 * @property {string} serviceName
 * @property {string} description
 * @property {ServiceExtras & Record<string, any>} extras
 * @property {boolean} online True while the service holds an open request
 *   channel, false for a previously seen offline service.
 * @property {string | null} [lastSeenAt] ISO-8601 stamp of when the service
 *   was last seen alive, or null when never stored.
 * @property {string} [runnerName] Online services only: the display name of
 *   the account that runs the service.
 * @property {boolean} [runByYou] Online services only: the caller runs it.
 * @property {boolean} [servesYou] Online services only: it would take the
 *   caller's requests on this project. A delegating service serves members
 *   other than its runner only where the runner is a maintainer or an admin.
 */

/**
 * Does `service` serve `task`, as its declared `extras.tasks` says?
 * @param {{serviceId?: string, extras?: {tasks?: string[]}}} service
 * @param {string} task one of TASKS
 * @returns {boolean}
 */
export function servesTask(service, task) {
  const declared = service?.extras?.tasks;
  return Array.isArray(declared) && declared.includes(task);
}

/**
 * The discovered services that serve `task`.
 * @param {DiscoveredService[] | undefined} services result of client.messages.discoverServices()
 * @param {string} task one of TASKS
 * @returns {DiscoveredService[]}
 */
export function filterServicesByTask(services, task) {
  return (services || []).filter((s) => servesTask(s, task));
}

/**
 * The parameter schema a service declares (ordered array), or [].
 * @param {{extras?: {parameters?: ServiceParam[]}}} service
 * @returns {ServiceParam[]}
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
  return service?.extras?.summary || service?.description || "";
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
  if (param.type === "enum") {
    if (param.default != null && opts.includes(param.default))
      return param.default;
    return opts[0] ?? "";
  }
  if (param.type === "multiselect") {
    const arr = Array.isArray(param.default) ? param.default : [];
    return opts.length ? arr.filter((x) => opts.includes(x)) : arr;
  }
  if (param.default !== undefined && param.default !== null)
    return param.default;
  switch (param.type) {
    case "number":
      return typeof param.min === "number" ? param.min : 0;
    case "boolean":
      return false;
    case "string":
    default:
      return "";
  }
}

/**
 * Default values keyed by param key — the initial form state.
 * @param {ServiceParam[]} schema getParamSchema(service)
 * @returns {Record<string, any>} { [key]: defaultValue }
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
 * @param {ServiceParam[]} schema getParamSchema(service)
 * @param {Record<string, any>} raw current form values
 * @returns {{values: Record<string, any>, errors: Record<string, string>}}
 */
// A decimal number as a person types one: an optional sign, digits with an
// optional fraction (or a bare fraction), an optional exponent, with spaces
// around it allowed. ASCII whitespace only, as in Python (each language's \s
// holds characters the other's lacks).
const DECIMAL = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\v\f\r]*$/;

/** `v` as a finite number when it is one or a decimal string, else null. */
function numberOf(v) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && DECIMAL.test(v)) n = Number(v);
  return n !== null && Number.isFinite(n) ? n : null;
}

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
      case "number": {
        // A finite number, or a string holding a decimal one; anything else
        // (blank, a boolean, a list, hex, an underscore, Infinity, a value too
        // large to be finite) is the param's default. The Python client's
        // `coerce` reads the same rule.
        let n = numberOf(v);
        if (n === null) n = defaultForParam(param);
        if (typeof param.min === "number") n = Math.max(param.min, n);
        if (typeof param.max === "number") n = Math.min(param.max, n);
        v = n;
        break;
      }
      case "boolean":
        v = v === true || v === "true";
        break;
      case "enum": {
        const opts = optionValues(param);
        if (opts.length && !opts.includes(v)) v = defaultForParam(param);
        break;
      }
      case "multiselect": {
        const opts = optionValues(param);
        const arr = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
        v = opts.length ? arr.filter((x) => opts.includes(x)) : arr;
        break;
      }
      case "string":
      default:
        v = v == null ? "" : String(v);
        break;
    }

    if (param.required) {
      const empty =
        v === "" || v == null || (Array.isArray(v) && v.length === 0);
      if (empty) errors[k] = `${param.label || k} is required`;
    }
    values[k] = v;
  }
  return { values, errors };
}
