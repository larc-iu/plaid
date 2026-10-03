// A pattern the Grew compiler sends to the server (Java syntax), read in JS
// for the tests that stand in for the server. It covers only what reaches the
// server: the translator's output (src/grew/userRegex.js), which writes `\z`
// for the end and `\x{…}` for a code point, and the compiler's own regexes
// (src/grew/regex.js), which JS reads as Java does.
export const serverRegExp = (pattern, flags = '') => {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = pattern[i + 1];
    if (n === 'z') out += '$';
    else if (n === 'x' && pattern[i + 2] === '{') out += '\\u';
    else out += c + n;
    i += 1;
  }
  return new RegExp(out, `u${flags.includes('i') ? 'i' : ''}`);
};
