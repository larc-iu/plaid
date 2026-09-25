// A count and its noun, agreeing: "1 text", "2 texts", "1,204 words".
export const plural = (n, word, words = `${word}s`) =>
  `${n.toLocaleString()} ${n === 1 ? word : words}`;
