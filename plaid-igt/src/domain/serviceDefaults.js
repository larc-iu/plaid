// The names of this app's built-in implementations, the `<name>` half of a
// `builtin:<name>` selection.
//
// Everything else about service defaults is shared with the other apps and
// lives in `@ui/domain/serviceDefaults`: the encoding, the project-config
// reads, and the resolution order a spot starts from.

export const BUILTIN_TOKENIZE_RULE_BASED = 'rule-based-punctuation';
export const BUILTIN_LINK_PRECEDENT = 'precedent';
export const BUILTIN_DETECT_SPEECH_SILERO = 'silero';
// Not chosen in a spot: Auto-analyze's "Copy previous analyses" step, named
// for the audit log and the provenance it stamps (builtinVersion.js).
export const BUILTIN_ANALYSIS_COPY = 'analysis-copy';
