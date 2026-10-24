// A literal as a JavaScript RegExp pattern that matches it, for a RegExp run
// here in the browser. The one copy (A6-4). A pattern sent to the server is a
// Java regex, which has its own escaper (domain/javaRegex.js in plaid-ui and
// the Grew literals in plaid-ud).
//
// Imports nothing, so the node suites can reach it by relative path.

export const escapeJsRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
