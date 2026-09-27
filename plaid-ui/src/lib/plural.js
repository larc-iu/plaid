// The noun a count is followed by. A regular noun is given as its singular
// ("entry", "project"), an irregular one as a [singular, plural] pair from the
// caller (['person', 'people'], ['address', 'addresses']).
export const plural = (n, noun) => {
  if (Array.isArray(noun)) return n === 1 ? noun[0] : noun[1];
  if (n === 1) return noun;
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
};
