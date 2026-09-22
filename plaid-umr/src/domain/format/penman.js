// PENMAN notation: the sentence-level graph of a .umr file.
//
// The grammar is the one validate.py scans (umrtools/validate.py:623), not a
// generic PENMAN one: a node is `(variable / concept)` followed by any number
// of `:relation value` children, where a value is a child node, a bare
// variable (re-entrancy), a quoted string or an atom.
//
// Whether a bare token is a node reference or an atom cannot be decided
// locally, because a reference may point forward. So the text is scanned once
// for `( var /` definitions before it is parsed, and the parser consults that
// set. A token that is shaped like a variable but was never defined is still
// read as a reference, so the caller sees the dangling edge rather than a
// silent atom.

// Concepts, atoms and variables all stop at whitespace, brackets, a colon or
// the start of a comment (validate.py:390).
const TOKEN = /^[^\s():#]+/;

// What a concept cannot hold, then: what ends TOKEN, and a quote, which
// starts a string. Written anyway, `10:30` read back as `10` and `C#` as `C`
// with no error. The picker offers a word's form as its concept, and forms
// hold all of these.
const NOT_IN_CONCEPT = /[\s():#"]/u;

/** Why `concept` cannot be written, or null when it can. */
export const conceptProblem = (concept) =>
  NOT_IN_CONCEPT.test(concept)
    ? `A concept cannot hold spaces, brackets, colons, quotes or #: ${concept}`
    : null;

// The UMR variable convention, ÚFAL's regex (validate.py:142). The letter run
// may be non-ASCII, so the Unicode property escape is load-bearing.
const VARIABLE = /^s[0-9]+\p{Ll}+[0-9]*$/u;

// The same, unanchored at the end: released files write `(s6t/ thing)` with no
// space, and the validator reads the variable off the front just like this.
const VARIABLE_PREFIX = /^s[0-9]+\p{Ll}+[0-9]*/u;

const variableFrom = (token) => VARIABLE_PREFIX.exec(token)?.[0] ?? token;

// A relation label: a colon then letters, digits and hyphens (validate.py:391).
const RELATION = /^:[-A-Za-z0-9]+/;

const STRING = /^"(?:\\.|[^"\\])*"/;

/** Why `relation` cannot be written, or null when it can. */
export const relationProblem = (relation) => {
  const text = String(relation ?? '').trim();
  const bare = text.startsWith(':') ? text.slice(1) : text;
  if (!bare) return 'A relation needs a name after its colon.';
  return /^[-A-Za-z0-9]+$/.test(bare)
    ? null
    : `A relation holds letters, digits and hyphens only: :${bare}`;
};

/**
 * Why `value`, the value of an attribute, cannot be written, or null when it
 * can. A quoted string may hold anything; a bare atom stops where a token
 * stops, so what it cannot hold is what would be read back as something else.
 */
export const attrValueProblem = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return 'An attribute needs a value.';
  if (text.startsWith('"')) {
    return STRING.test(text) && STRING.exec(text)[0] === text
      ? null
      : `A quoted value needs its closing quote: ${text}`;
  }
  if (text.includes('"')) return `A value holds a quote only around the whole of it: ${text}`;
  return NOT_IN_CONCEPT.test(text)
    ? `A value cannot hold spaces, brackets, colons or #, unless it is quoted: ${text}`
    : null;
};

// A quoted string and a comment must not be mistaken for graph text when the
// definition set is collected, so both are blanked first. Newlines survive so
// that positions still line up.
function maskLiterals(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const match = STRING.exec(text.slice(i));
      const len = match ? match[0].length : text.length - i;
      out += ' '.repeat(len);
      i += len;
    } else if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function definedVariables(masked) {
  const found = new Set();
  const re = /\(\s*([^\s():#]+)\s*\//g;
  let match;
  while ((match = re.exec(masked))) found.add(variableFrom(match[1]));
  return found;
}

class Scanner {
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.line = 1;
    this.col = 1;
  }

  get done() {
    return this.i >= this.text.length;
  }

  peek() {
    return this.text[this.i];
  }

  advance(n) {
    for (let k = 0; k < n; k++) {
      if (this.text[this.i] === '\n') {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
      this.i++;
    }
  }

  // Whitespace and comments are the same thing to the grammar: a `#` runs to
  // the end of the line, and only outside a string (strings are read whole).
  skip() {
    for (;;) {
      while (!this.done && /\s/.test(this.peek())) this.advance(1);
      if (this.peek() === '#') {
        while (!this.done && this.peek() !== '\n') this.advance(1);
        continue;
      }
      return;
    }
  }

  here() {
    return { line: this.line, col: this.col };
  }

  take(re) {
    const match = re.exec(this.text.slice(this.i));
    if (!match) return null;
    const value = match[0];
    this.advance(value.length);
    return value;
  }

  /** The rest of the current line, for an error message. */
  rest() {
    const end = this.text.indexOf('\n', this.i);
    return this.text.slice(this.i, end === -1 ? this.text.length : end).trim();
  }
}

/**
 * Parse PENMAN text into a graph. Never throws: everything it cannot read
 * becomes an entry in `errors`.
 *
 * @param {string} text
 * @returns {{ root: string|null, nodes: Map<string, object>, errors: Array<{message: string, line: number, col: number}> }}
 *   Each node is `{ var, concept, children: [{ rel, kind, value, inline }] }`.
 *   `kind` is 'node' (value is the target variable, `inline` true where the
 *   child node was written out), 'string' (value keeps its quotes) or 'atom'.
 */
export function parsePenman(text) {
  const errors = [];
  const nodes = new Map();
  const source = typeof text === 'string' ? text : '';
  const defined = definedVariables(maskLiterals(source));
  const scanner = new Scanner(source);

  const fail = (message, at) => errors.push({ message, line: at.line, col: at.col });

  function readValue(children, rel) {
    scanner.skip();
    const at = scanner.here();
    const ch = scanner.peek();
    if (ch === '(') {
      const child = readNode();
      children.push({ rel, kind: 'node', value: child, inline: true });
      return;
    }
    if (ch === '"') {
      const raw = scanner.take(STRING);
      if (raw === null) {
        fail(`Unterminated string: ${scanner.rest()}`, at);
        scanner.advance(scanner.text.length - scanner.i);
        return;
      }
      children.push({ rel, kind: 'string', value: raw });
      return;
    }
    const token = scanner.take(TOKEN);
    if (token === null) {
      fail(`Expected a value after '${rel}', found '${scanner.rest() || 'end of graph'}'.`, at);
      return;
    }
    if (defined.has(token)) {
      children.push({ rel, kind: 'node', value: token, inline: false });
      return;
    }
    if (VARIABLE.test(token)) {
      fail(`The node id (variable) '${token}' is unknown. No such node is defined.`, at);
      children.push({ rel, kind: 'node', value: token, inline: false });
      return;
    }
    children.push({ rel, kind: 'atom', value: token });
  }

  function readNode() {
    const open = scanner.here();
    scanner.advance(1); // the '('
    scanner.skip();
    const variable = scanner.take(VARIABLE_PREFIX) ?? scanner.take(TOKEN);
    if (variable === null || variable === undefined) {
      fail(`Expected a node variable id, found '${scanner.rest()}'.`, scanner.here());
      return null;
    }
    scanner.skip();
    if (scanner.peek() === '/') {
      scanner.advance(1);
      scanner.skip();
    } else {
      fail(`Expected slash and concept string after '${variable}'.`, scanner.here());
    }
    const concept = scanner.peek() === ')' ? null : scanner.take(TOKEN);
    if (concept === null) {
      fail(`Expected a concept string for '${variable}'.`, scanner.here());
    }
    const node = { var: variable, concept: concept ?? '', children: [] };
    if (nodes.has(variable)) {
      fail(`The node id (variable) '${variable}' is not unique.`, open);
    } else {
      nodes.set(variable, node);
    }

    for (;;) {
      scanner.skip();
      if (scanner.done) {
        fail(`Graph ended without closing node '${variable}'.`, scanner.here());
        return variable;
      }
      const ch = scanner.peek();
      if (ch === ')') {
        scanner.advance(1);
        return variable;
      }
      if (ch === ':') {
        const at = scanner.here();
        const rel = scanner.take(RELATION);
        if (rel === null) {
          fail(`Expected a relation label, found '${scanner.rest()}'.`, at);
          scanner.advance(1);
          continue;
        }
        readValue(node.children, rel);
        continue;
      }
      // Anything else here is junk: report it once and step past the whole
      // token so the rest of the graph is still read.
      fail(`Expected a relation or a closing bracket, found '${scanner.rest()}'.`, scanner.here());
      if (scanner.take(TOKEN) === null) scanner.advance(1);
    }
  }

  scanner.skip();
  if (scanner.done) return { root: null, nodes, errors };
  if (scanner.peek() !== '(') {
    fail(
      `Expected the opening bracket of the root node, found '${scanner.rest()}'.`,
      scanner.here(),
    );
    return { root: null, nodes, errors };
  }
  const root = readNode();
  scanner.skip();
  if (!scanner.done) {
    fail(
      `Unexpected content after the topmost closing bracket: '${scanner.rest()}'.`,
      scanner.here(),
    );
  }
  return { root: root ?? null, nodes, errors };
}

const edgeKey = (parent, index) => `${parent}\u0000${index}`;

// Depth-first pre-order over child order, descending into a node the first
// time an edge reaches it. Iterative rather than recursive only so that a
// pathological graph cannot blow the stack.
function walk(graph, visit) {
  const { root, nodes } = graph;
  if (!root || !nodes.has(root)) return;
  const seen = new Set([root]);
  const stack = [{ variable: root, next: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const node = nodes.get(frame.variable);
    if (!node || frame.next >= node.children.length) {
      stack.pop();
      continue;
    }
    const index = frame.next++;
    const child = node.children[index];
    if (child.kind !== 'node') continue;
    const alreadySeen = seen.has(child.value);
    visit(frame.variable, index, child, alreadySeen);
    if (!alreadySeen && nodes.has(child.value)) {
      seen.add(child.value);
      stack.push({ variable: child.value, next: 0 });
    }
  }
}

/**
 * The edges at which each node is written out, by first visit: a depth-first
 * walk from the root following child order, expanding a node the first time an
 * edge reaches it and writing a bare variable everywhere else.
 *
 * @param {{root: string|null, nodes: Map}} graph
 * @returns {Set<[string, number]>} (parent variable, child index) pairs
 */
export function treeEdges(graph) {
  const first = new Map();
  walk(graph, (parent, index, child, alreadySeen) => {
    if (alreadySeen || first.has(child.value)) return;
    first.set(child.value, [parent, index]);
  });
  return new Set(first.values());
}

// Where each node is written out when the graph carries `inline` markers: the
// marked edge wins, so a graph that came from a file is written back at the
// same sites. A node whose marked edge is unreachable still gets written at
// the first edge that reaches it.
function expansionSites(graph) {
  const marked = new Map();
  const first = new Map();
  let anyMarked = false;
  walk(graph, (parent, index, child, alreadySeen) => {
    if (child.inline === true) {
      anyMarked = true;
      if (!marked.has(child.value)) marked.set(child.value, edgeKey(parent, index));
    }
    if (!alreadySeen && !first.has(child.value)) first.set(child.value, edgeKey(parent, index));
  });
  if (!anyMarked) return new Set(first.values());
  const sites = new Set();
  for (const [target, key] of first) sites.add(marked.get(target) ?? key);
  return sites;
}

/**
 * Write a graph back as PENMAN, in the canonical shape the ÚFAL spec shows:
 * the root on the first line, every child on its own line, four spaces of
 * indentation per level, and closing brackets accumulating at the end of the
 * last line of a subtree.
 *
 * @param {{root: string|null, nodes: Map}} graph
 * @param {{indent?: number}} [options]
 * @returns {string}
 */
export function serializePenman(graph, options = {}) {
  const indent = options.indent ?? 4;
  const { root, nodes } = graph || {};
  if (!root || !nodes || !nodes.has(root)) return '';
  const sites = expansionSites(graph);
  const written = new Set([root]);

  const pad = (depth) => ' '.repeat(indent * depth);

  function lines(variable, depth) {
    const node = nodes.get(variable);
    const out = [`${pad(depth)}(${variable} / ${node.concept}`];
    node.children.forEach((child, index) => {
      const childPad = pad(depth + 1);
      const expandHere =
        child.kind === 'node' &&
        nodes.has(child.value) &&
        !written.has(child.value) &&
        sites.has(edgeKey(variable, index));
      if (expandHere) {
        written.add(child.value);
        const sub = lines(child.value, depth + 1);
        sub[0] = `${childPad}${child.rel} ${sub[0].slice(childPad.length)}`;
        out.push(...sub);
      } else {
        out.push(`${childPad}${child.rel} ${child.value}`);
      }
    });
    out[out.length - 1] += ')';
    return out;
  }

  return lines(root, 0).join('\n');
}
