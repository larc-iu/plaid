// Error types thrown by the Grew → Plaid-QL pipeline.
//
//   - GrewParseError  — the input is not valid Grew (lexing/parsing). Carries a
//                       1-based line/col and the offending source line so the UI
//                       can render a caret.
//   - GrewUnsupportedError — the input is valid Grew, but uses a construct this
//                       compiler cannot express in Plaid's query language (the
//                       "residue"; see compile.js) or the rewriting engine cannot
//                       apply to UD data. Names the feature so the UI can tell
//                       the user precisely what to drop.
//   - GrewRuntimeError — a rule failed while rewriting a sentence: a command
//                       whose edge or feature is missing, a lemma a dependency
//                       still needs, a rule that never terminates. Carries the
//                       rule name and command line.
//
// Both extend GrewError so a caller can `catch (e) { if (e instanceof GrewError) … }`
// to separate "your query is the problem" from "the server/network is the problem".
//
// A message is the person's sentence, in the interface's language: the node
// test suite loads this file, so i18n.js comes by a relative path.

import { t } from '../../../plaid-ui/src/lib/i18n.js';

export class GrewError extends Error {}

export class GrewParseError extends GrewError {
  constructor(message, line = null, col = null, sourceLine = null) {
    super(message);
    this.name = 'GrewParseError';
    this.line = line;
    this.col = col;
    this.sourceLine = sourceLine;
  }
}

export class GrewUnsupportedError extends GrewError {
  constructor(feature, message, line = null) {
    super(message || t('Unsupported Grew feature: {feature}', { feature }));
    this.name = 'GrewUnsupportedError';
    this.feature = feature;
    this.line = line;
  }
}

export class GrewRuntimeError extends GrewError {
  constructor(message, { rule = null, line = null } = {}) {
    super(message);
    this.name = 'GrewRuntimeError';
    this.rule = rule;
    this.line = line;
  }
}
