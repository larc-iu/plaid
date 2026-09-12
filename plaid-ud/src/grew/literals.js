// Writing user text into Grew source, safely.
//
// Three places generate a pattern from something a person typed or clicked: the
// quick search box, the "narrow to this value" click on a count row, and the
// assistant's citation links. They all face the same question, so they all ask
// it here rather than each carrying its own copy of the escaping rules.
//
// Two of the rules are about what Grew CANNOT quote. A string is quotable
// (`"…"`), and a regex literal is a quoted string too (`re"…"`), but an arc
// label and a feature key are written BARE, so text that is not bare-safe
// cannot go there at all and the caller has to say something else instead.

/** A Grew string literal. The quote and the backslash escape, and so do the
 * two whitespace characters the lexer decodes: a raw newline ends the literal
 * ("Unterminated string") where `\n` round-trips. Nothing else does, because
 * this text is read by our own lexer and not by a shell. */
export const quote = (text) =>
  `"${String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;

/** The text as a regex that matches it literally: someone looking for `dog.`
 * wants a full stop. */
export const literalRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** That regex, anchored, as a Grew regex literal. An exact match written the
 * long way, for the positions where a bare word will not go. */
export const exactRegex = (text) => `re${quote(`^${literalRegex(text)}$`)}`;

/** An arc label may be written bare: `-[nsubj]->`, `-[obl:tmod]->`. */
export const BARE_LABEL = /^[A-Za-z_][A-Za-z0-9_:]*$/u;

/** A feature key may be written bare: `[Number=…]`. UD keys are alphanumeric,
 * and a project can still hold anything, which is what the Validation tab is
 * for. */
export const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
