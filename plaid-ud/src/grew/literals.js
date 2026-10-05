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

/** A regex as a Grew regex literal, `re"…"`, which is raw: the lexer keeps
 * every backslash as written and reads only `\"`. So the regex goes in as it
 * is, an escape pair stays a pair, a bare quote becomes `\"` and a newline
 * `\n` (a raw one ends the literal). A lone backslash at the end has nothing
 * to escape and no raw spelling, so it is written as the regex for a
 * backslash. */
export const regexLiteral = (regex) => {
  const s = String(regex);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const e = s[i + 1];
      if (e === undefined) out += '\\\\';
      else out += e === '\n' ? '\\n' : `\\${e}`;
      i++;
    } else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else out += c;
  }
  return `re"${out}"`;
};

/** The text as a regex that matches it literally: someone looking for `dog.`
 * wants a full stop. */
export const literalRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** That regex, anchored, as a Grew regex literal. An exact match written the
 * long way, for the positions where a bare word will not go. */
export const exactRegex = (text) => regexLiteral(`^${literalRegex(text)}$`);

/** An arc label may be written bare: `-[nsubj]->`, `-[obl:tmod]->`. */
export const BARE_LABEL = /^[A-Za-z_][A-Za-z0-9_:]*$/u;

/** A feature key may be written bare: `[Number=…]`. UD keys are alphanumeric,
 * and a project can still hold anything, which is what the Validation tab is
 * for. */
export const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
