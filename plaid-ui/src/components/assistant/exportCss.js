// The stylesheet a web page export carries (exportHtml.js): the app's own
// rules, taken from the stylesheets the browser has loaded, kept only where a
// selector matches something on the page, so the file holds the few dozen KB
// it uses and not the whole app's CSS.
//
// What is changed on the way:
// - The app turns dark mode on with a `.dark` class, which a page with no
//   script cannot set. A rule that needs `.dark` is moved under
//   `@media (prefers-color-scheme: dark)` with the class taken out, so the
//   page follows the reader's system setting.
// - Nothing is fetched: @import and @font-face rules go, as does any
//   declaration with a url() that is not a data: URI. The typeface for
//   language data falls through `--plaid-font-text` to Charis SIL where the
//   reader has it installed, and to the system's serif where not.
// - @keyframes go: nothing on the page moves.

// State a static page is never in, and parts of an element querySelector
// cannot match. A selector is tried as written first, then without these.
const PSEUDO_ELEMENT =
  /::?(?:before|after|placeholder|marker|selection|backdrop|file-selector-button|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+)(?:\([^)]*\))?/g;
const STATE =
  /:(?:hover|focus-visible|focus-within|focus|active|visited|disabled|enabled|checked|placeholder-shown|autofill|target|indeterminate|invalid|valid|required|optional|read-only|read-write|default|popover-open|user-invalid|user-valid)(?![\w-])/g;

// The parts of a selector list, split at the commas outside any brackets.
const selectorParts = (text) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
};

const query = (doc, sel) => {
  try {
    return !!doc.querySelector(sel);
  } catch {
    return null;
  }
};

// Whether a selector matches anything on the page, in some state.
const used = (doc, sel) => {
  if (query(doc, sel)) return true;
  const bare = sel
    .replace(PSEUDO_ELEMENT, '')
    .replace(STATE, '')
    .replace(/[\s>+~]+$/, '')
    .trim();
  if (!bare) return true;
  return bare !== sel && !!query(doc, bare);
};

// `.dark` as a class token in a selector.
const DARK = /\.dark(?![\w\\-])/;

// A dark-mode selector with the class taken out: Tailwind's variant
// (`.dark\:x:is(.dark *)`) and the theme's own `.dark { ... }` block.
const undark = (sel) => {
  const out = sel
    .replace(/:is\(\s*\.dark\s+\*\s*\)/g, '')
    .replace(/^\.dark(?![\w\\-])\s*/, '')
    .trim();
  return out || ':root';
};

// A rule's declarations with every external url() dropped.
const declarations = (style) => {
  const text = style.cssText;
  if (!/url\(/i.test(text)) return text;
  const out = [];
  for (let i = 0; i < style.length; i += 1) {
    const prop = style[i];
    const value = style.getPropertyValue(prop);
    if (/url\(\s*(?!['"]?data:)/i.test(value)) continue;
    const important = style.getPropertyPriority(prop) ? ' !important' : '';
    out.push(`${prop}: ${value}${important};`);
  }
  return out.join(' ');
};

// The `@media ...` or `@supports ...` that opens a grouping rule.
const prelude = (rule) => rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();

const rulesOf = (sheet) => {
  try {
    return sheet.cssRules ? [...sheet.cssRules] : [];
  } catch {
    // A stylesheet from another origin cannot be read, and is not ours.
    return [];
  }
};

const walk = (rules, doc, light, dark) => {
  for (const rule of rules) {
    if (rule.selectorText != null && rule.style) {
      const parts = selectorParts(rule.selectorText);
      const lit = parts.filter((p) => !DARK.test(p) && used(doc, p));
      const darkParts = parts
        .filter((p) => DARK.test(p))
        .map(undark)
        .filter((p) => used(doc, p));
      const body = declarations(rule.style);
      if (!body.trim()) continue;
      if (lit.length) light.push(`${lit.join(', ')} { ${body} }`);
      if (darkParts.length) dark.push(`${darkParts.join(', ')} { ${body} }`);
      continue;
    }
    const head = rule.cssText.trimStart();
    if (/^@(import|font-face|keyframes|-webkit-keyframes|page|namespace)\b/i.test(head)) continue;
    if (rule.cssRules) {
      const innerLight = [];
      const innerDark = [];
      walk([...rule.cssRules], doc, innerLight, innerDark);
      const at = prelude(rule);
      if (innerLight.length) light.push(`${at} {\n${innerLight.join('\n')}\n}`);
      if (innerDark.length) dark.push(`${at} {\n${innerDark.join('\n')}\n}`);
      continue;
    }
    // Anything else (@property, @charset) is kept as it is.
    if (!/url\(/i.test(head)) light.push(head);
  }
};

/**
 * The CSS from `sheets` (a StyleSheetList or an array of sheets) that the
 * page `doc` uses, dark-mode rules moved under the reader's system setting.
 */
export const usedCss = (sheets, doc) => {
  const light = [];
  const dark = [];
  for (const sheet of sheets || []) walk(rulesOf(sheet), doc, light, dark);
  const out = light.join('\n');
  return dark.length ? `${out}\n@media (prefers-color-scheme: dark) {\n${dark.join('\n')}\n}` : out;
};
