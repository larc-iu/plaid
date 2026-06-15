// Error types thrown by the Grew → Plaid-QL pipeline.
//
//   - GrewParseError  — the input is not valid Grew (lexing/parsing). Carries a
//                       1-based line/col and the offending source line so the UI
//                       can render a caret.
//   - GrewUnsupportedError — the input is valid Grew, but uses a construct this
//                       compiler cannot express in Plaid's query language (the
//                       "residue"; see compile.js). Names the feature so the UI
//                       can tell the user precisely what to drop.
//
// Both extend GrewError so a caller can `catch (e) { if (e instanceof GrewError) … }`
// to separate "your query is the problem" from "the server/network is the problem".

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
    super(message || `Unsupported Grew feature: ${feature}`);
    this.name = 'GrewUnsupportedError';
    this.feature = feature;
    this.line = line;
  }
}
