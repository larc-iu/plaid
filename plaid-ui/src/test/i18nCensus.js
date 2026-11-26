// What a source file says to a person, read off its syntax tree: the messages
// it passes to t(), tx() and msg(), and the text it shows without them.
//
// Two readers: i18n.sources.test.js, which holds the finished directories to
// "nothing left unwrapped" and checks every catalog against the messages, and
// `node plaid-ui/scripts/i18n-census.mjs <dir>`, which lists what is left to
// do in a directory.
//
// FOUND AS UNWRAPPED (each with its kind):
//   jsxText   text between JSX tags
//   jsxAttr   a string given to a JSX attribute that people read (title,
//             label, placeholder, ...), or to any attribute when it reads
//             like a phrase
//   jsxString a string inside a JSX expression: {saving ? 'Saving' : 'Save'}
//   litText   text or a read attribute in a lit-html template
//   countOf   countOf(), plural() or andList() from lib/plural.js, which
//             build English only
//   moduleT   t() or tx() called at module level, before the language is known
//   sentence  any other string that reads like a sentence (a toast, a
//             warning, an error). This one is a guess both ways: it is listed
//             for a person to judge and is never held to zero.
//
// A line ending in `// i18n-ignore` (or `{/* i18n-ignore */}`), or the line
// after a comment line that is only that, is left out: a proper name such as
// "ELAN", a unit, a sample of data.

import fs from 'node:fs';
import path from 'node:path';
import * as espree from 'espree';

const MESSAGE_FUNCTIONS = new Set(['t', 'tx', 'msg']);
const ENGLISH_ONLY = new Set(['countOf', 'plural', 'andList']);

// Attributes whose string is always for a person.
const READ_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'description',
  'tooltip',
  'hint',
  'heading',
  'emptyText',
  'confirmLabel',
  'cancelLabel',
]);
// Attributes whose string never is.
const CODE_ATTRS =
  /^(className|class|id|key|type|role|name|value|defaultValue|variant|size|side|align|to|href|src|htmlFor|for|target|rel|method|mode|dir|lang|style|d|viewBox|fill|stroke|xmlns|accept|autoComplete|inputMode|pattern|as|asChild|orientation|position|tabIndex|slot|wrap|loading|decoding|preload|crossOrigin|data-.*|aria-(hidden|live|haspopup|controls|labelledby|describedby|current|sort|orientation|autocomplete|expanded|selected|checked|pressed|invalid|busy|modal|atomic|relevant|owns|activedescendant))$/;

const hasWord = (s) => /\p{L}{2}/u.test(s);
// A phrase: a capitalised word then more, or two words with a space.
const readsLikePhrase = (s) => /^\P{L}*\p{Lu}\p{Ll}+/u.test(s) || /\p{L}{2,}\s+\p{L}{2,}/u.test(s);
// A sentence: a capitalised word, a space, and another word.
const readsLikeSentence = (s) => /^\P{L}{0,3}\p{Lu}\p{Ll}+[\s,]+\p{L}+/u.test(s);

const calleeName = (node) =>
  node.callee?.type === 'Identifier'
    ? node.callee.name
    : node.callee?.type === 'MemberExpression' && node.callee.property?.type === 'Identifier'
      ? node.callee.property.name
      : null;

const staticString = (node) => {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
};

// The strings of an expression that may end up as its value: through ?:, &&,
// || and ??, and a template's own text.
function stringsOf(node, out = []) {
  if (!node) return out;
  const s = staticString(node);
  if (s !== null) out.push({ text: s, node });
  else if (node.type === 'TemplateLiteral') {
    out.push({ text: node.quasis.map((q) => q.value.cooked).join('{}'), node });
  } else if (node.type === 'ConditionalExpression') {
    stringsOf(node.consequent, out);
    stringsOf(node.alternate, out);
  } else if (node.type === 'LogicalExpression') {
    stringsOf(node.left, out);
    stringsOf(node.right, out);
  }
  return out;
}

// The text of a lit-html template with its tags taken out, and the values of
// the attributes people read.
function litStrings(quasi) {
  const whole = quasi.quasis.map((q) => q.value.cooked ?? '').join('\ufffc');
  const found = [];
  for (const m of whole.matchAll(
    /\s(title|aria-label|placeholder|alt)="([^"\ufffc]*\p{L}{2}[^"\ufffc]*)"/gu,
  )) {
    found.push(m[2]);
  }
  for (const text of whole.replace(/<!--[\s\S]*?-->/g, '').split(/<[^>]*>/)) {
    const clean = text.replace(/\ufffc/g, ' ').trim();
    if (hasWord(clean)) found.push(clean);
  }
  return found;
}

/**
 * Read one source file.
 *
 * @returns {{
 *   keys: {key: string, line: number, fn: string}[],
 *   unwrapped: {kind: string, line: number, text: string}[],
 * }}
 */
function scanSource(code, fileName = 'file.jsx') {
  let ast;
  try {
    ast = espree.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
      loc: true,
      range: true,
    });
  } catch (err) {
    throw new Error(`${fileName}: ${err.message}`, { cause: err });
  }
  const lines = code.split('\n');
  const ignored = (line) =>
    /i18n-ignore/.test(lines[line - 1] ?? '') ||
    /^\s*(\/\/|\{\/\*)\s*i18n-ignore/.test(lines[line - 2] ?? '');

  const keys = [];
  const unwrapped = [];
  const flag = (kind, node, text) => {
    const line = node.loc.start.line;
    if (!ignored(line)) unwrapped.push({ kind, line, text: text.replace(/\s+/g, ' ').trim() });
  };
  // Strings already accounted for by a more specific kind.
  const claimed = new WeakSet();

  const walk = (node, ctx) => {
    if (!node || typeof node.type !== 'string') return;
    let inner = ctx;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return;
      case 'ExportNamedDeclaration':
        if (node.source) return;
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        inner = { ...ctx, inFunction: true };
        break;
      case 'CallExpression': {
        const name = calleeName(node);
        if (node.callee.type === 'Identifier' && MESSAGE_FUNCTIONS.has(name)) {
          const key = staticString(node.arguments[0]);
          if (key !== null) keys.push({ key, line: node.loc.start.line, fn: name });
          if (name !== 'msg' && !ctx.inFunction) flag('moduleT', node, `${name}() at module level`);
          // The message is accounted for. Its values are read on: a tag
          // function's JSX, a nested message.
          node.arguments.slice(1).forEach((a) => walk(a, ctx));
          return;
        }
        if (node.callee.type === 'Identifier' && ENGLISH_ONLY.has(name)) {
          flag(
            'countOf',
            node,
            code.slice(node.range[0], Math.min(node.range[1], node.range[0] + 80)),
          );
          node.arguments.forEach((a) => stringsOf(a).forEach((s) => claimed.add(s.node)));
        }
        // Not for a person: the console, a test id lookup, a class list.
        if (
          node.callee.type === 'MemberExpression' &&
          node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'console'
        ) {
          return;
        }
        break;
      }
      case 'TaggedTemplateExpression':
        if (
          node.tag.type === 'Identifier' &&
          (node.tag.name === 'html' || node.tag.name === 'svg')
        ) {
          litStrings(node.quasi).forEach((text) => flag('litText', node, text));
          node.quasi.quasis.forEach((q) => claimed.add(q));
          claimed.add(node.quasi);
          node.quasi.expressions.forEach((e) => walk(e, ctx));
          return;
        }
        break;
      case 'JSXText':
        if (hasWord(node.value)) flag('jsxText', node, node.value);
        return;
      case 'JSXAttribute': {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
        const direct =
          node.value?.type === 'Literal' ? [{ text: node.value.value, node: node.value }] : [];
        const viaExpr =
          node.value?.type === 'JSXExpressionContainer' ? stringsOf(node.value.expression) : [];
        for (const s of [...direct, ...viaExpr]) {
          if (typeof s.text !== 'string') continue;
          claimed.add(s.node);
          if (CODE_ATTRS.test(name) || !hasWord(s.text)) continue;
          if (READ_ATTRS.has(name) || readsLikePhrase(s.text))
            flag('jsxAttr', s.node, `${name}="${s.text}"`);
        }
        break;
      }
      case 'JSXExpressionContainer':
        if (ctx.parentType === 'JSXElement' || ctx.parentType === 'JSXFragment') {
          for (const s of stringsOf(node.expression)) {
            claimed.add(s.node);
            if (hasWord(s.text)) flag('jsxString', s.node, s.text);
          }
        }
        break;
      case 'Literal':
        if (typeof node.value === 'string' && !claimed.has(node) && readsLikeSentence(node.value)) {
          flag('sentence', node, node.value);
        }
        return;
      case 'TemplateLiteral':
        if (!claimed.has(node)) {
          const text = node.quasis.map((q) => q.value.cooked ?? '').join('{}');
          if (readsLikeSentence(text)) flag('sentence', node, text);
        }
        node.expressions.forEach((e) => walk(e, inner));
        return;
      default:
    }
    const next = { ...inner, parentType: node.type };
    for (const [key, child] of Object.entries(node)) {
      if (key === 'loc' || key === 'range' || key === 'type') continue;
      if (Array.isArray(child)) child.forEach((c) => walk(c, next));
      else if (child && typeof child === 'object') walk(child, next);
    }
  };
  walk(ast, { inFunction: false, parentType: null });
  return { keys, unwrapped };
}

/** Every non-test .js and .jsx under a directory, `test` directories left out. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' || e.name === 'locales' ? [] : sourceFiles(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.(test|spec)\.jsx?$/.test(e.name)
      ? [full]
      : [];
  });
}

/** scanSource over a directory or a file: [{file, keys, unwrapped}]. */
export function scanPath(target) {
  const files = fs.statSync(target).isDirectory() ? sourceFiles(target) : [target];
  return files.map((file) => ({ file, ...scanSource(fs.readFileSync(file, 'utf8'), file) }));
}
