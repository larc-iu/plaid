// The `@` run the caret is sitting in, and what replacing it does to the text.
//
// This is the whole of the fiddly part, kept out of React so it can be tested
// as arithmetic. What a mention OFFERS is the app's answer (see each adapter's
// `mentions`) and what it INSERTS is plain text: the reference spellings the
// model already reads, `s5` and `Text 3 s5` and `gam 1`, the same ones "Ask"
// writes and the same ones it cites back. Nothing hidden travels with the
// message, because the message is the record: it is what the store holds, what
// the admin area shows, and what exportMarkdown.js writes out.

// A query runs to the caret and may hold spaces, because document names do
// ("Text 3"). Two things end it: a newline, and running away with itself.
const MAX_QUERY = 80;

/**
 * The mention being typed at `caret`, or null.
 *
 * The `@` is the last one before the caret, and it counts only at the start of
 * the text or after whitespace, so an email address is not a mention. The
 * query is everything from there to the caret: text after the caret is left
 * alone, which is what makes typing into the middle of a finished message
 * behave.
 *
 * @returns {{query: string, from: number, to: number} | null}
 */
export const activeMention = (text, caret) => {
  if (typeof text !== 'string' || typeof caret !== 'number' || caret < 0) return null;
  const head = text.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(head[at - 1])) return null;
  const query = head.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n\r]/.test(query)) return null;
  return { query, from: at, to: caret };
};

/**
 * Replace the mention at `caret` with `insert`, leaving one space after it so
 * the next word is not glued on.
 *
 * @returns {{text: string, caret: number}} unchanged when no mention is active.
 */
export const insertMention = (text, caret, insert) => {
  const mention = activeMention(text, caret);
  if (!mention) return { text, caret };
  const before = text.slice(0, mention.from);
  const after = text.slice(mention.to);
  const written = after.startsWith(' ') ? insert : `${insert} `;
  return { text: `${before}${written}${after}`, caret: before.length + written.length };
};

// What the list shows for a query. Matches the LABEL or the HINT, because a
// reader looking for a sentence knows what it says and not that it is s37, and
// caps each group: a document with five hundred sentences is a list nobody
// scrolls, and the query is how you narrow it.
const PER_GROUP = 50;

export const filterMentions = (groups, query) => {
  const q = (query || '').trim().toLowerCase();
  const hit = (item) =>
    !q ||
    String(item.label ?? '')
      .toLowerCase()
      .includes(q) ||
    String(item.hint ?? '')
      .toLowerCase()
      .includes(q);
  return (groups || [])
    .map((group) =>
      'group' in group
        ? { ...group, items: (group.items || []).filter(hit).slice(0, PER_GROUP) }
        : group,
    )
    .filter((group) => ('group' in group ? group.items.length > 0 : hit(group)));
};
