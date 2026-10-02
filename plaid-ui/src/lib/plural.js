// The noun a count is followed by. A regular noun is given as its singular
// ("entry", "project"), an irregular one as a [singular, plural] pair from the
// caller (['person', 'people'], ['address', 'addresses']).
export const plural = (n, noun) => {
  if (Array.isArray(noun)) return n === 1 ? noun[0] : noun[1];
  if (n === 1) return noun;
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
};

// A count and its noun, agreeing, the count written for the reader's locale:
// "1 text", "2 texts", "1,204 words". `many` is for a plural `plural` would
// not make ("entry", "entries" it does: "person", "people" it does not).
export const countOf = (n, one, many) =>
  `${n.toLocaleString()} ${many === undefined ? plural(n, one) : n === 1 ? one : many}`;
