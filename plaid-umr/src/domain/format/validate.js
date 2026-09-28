// A port of umrtools/validate.py's levels 1 to 3, minus the checks that are
// about lines rather than meaning.
//
// Left out on purpose: the file-format tests (trailing whitespace, block
// counts, empty lines) and the interlinear-glossing tests, because Plaid
// stores structure and regenerates the lines. Kept: NFC, which regenerating
// the lines does not give (a string stored with a combining accent is written
// with one), and everything that judges the graph: the sentence graph and the
// values in it, the alignment, the document graph and the level-3 contents
// checks. Each finding carries validate.py's own test id as `code`, so a
// message here can be traced to the line it came from.

import {
  ATTRIBUTES,
  DOC_CONSTANTS,
  DOC_RELATIONS,
  DISCOURSE_CONCEPTS,
  KNOWN_RELATIONS,
  NON_EVENT_ROLESETS,
} from './inventory.js';
import { nfc, treeEdges } from './penman.js';

const OP = /^:op([1-9][0-9]*)$/;
const VARIABLE = /^s[0-9]+\p{Ll}+[0-9]*$/u;
const PUNCTUATION = /^\p{P}+$/u;
const WIKIDATA_ID = /^Q[1-9][0-9]*$/;
const ROLESET = /^.+-91$/;
const ARG = /^:ARG[0-6]$/;
const ARG_OF = /^:ARG[0-6]-of$/;

const uninvert = (relation) => relation.replace(/-of$/, '');

// "a node", "an atom": the kinds a child of a node comes in.
const aKind = (kind) => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;

// The bare values validate.py reads (validate.py:393-398): an atom of
// lowercase letters, digits, `+` and `-`, or a number with a decimal point
// or a time's colon. An atom with a capital or an underscore is read and
// reported; anything else is not read at all, and the reader then expects a
// node where the value stands.
const ATOM = /^[-+a-z0-9]+$/;
const NUMBER = /^[0-9]+(?:[.:][0-9]+)?$/;
const UPPER_ATOM = /^[-+a-z0-9A-Z_]+$/;

// What the validator knows of a relation, inverse or numbered `:opN` read as
// their base, or null for a relation it calls unknown.
const knownRelation = (relation) => {
  const base = uninvert(relation);
  return KNOWN_RELATIONS[base] ?? (OP.test(base) ? KNOWN_RELATIONS[':op1'] : null);
};

/**
 * Why `relation` is not a UMR relation, or null when it is. Roles are a
 * closed set (a concept is free text): the canvas and text mode refuse what
 * the validator would report as `unknown-relation`.
 */
export const unknownRelationProblem = (relation) => {
  const text = String(relation ?? '').trim();
  const rel = text.startsWith(':') ? text : `:${text}`;
  return knownRelation(rel) ? null : `Unknown relation '${rel}'.`;
};

/**
 * Why `relation` is not one of the document-level `group`'s relations
 * (`temporal`, `modal`, `coref`), or null when it is: the same closed set
 * `unknown-document-relation` judges by, so the canvas refuses what the
 * validator would report (`:FullAff` as the guidelines' examples write it).
 */
export const unknownDocRelationProblem = (group, relation, sets = 'validator') => {
  const known = DOC_RELATIONS[group]?.[sets] ?? DOC_RELATIONS[group]?.validator ?? [];
  return known.includes(relation)
    ? null
    : `Unknown document-level ${group} relation '${relation}'.`;
};

// The value set a relation's atom is judged against. An attribute validate.py
// leaves open is still enumerated in the guidelines, so the schema set is used
// for it when the caller asked for the schema inventory.
function valuesFor(relation, sets) {
  const attribute = ATTRIBUTES[relation];
  if (attribute) return attribute[sets] ?? attribute.validator;
  return KNOWN_RELATIONS[relation]?.values ?? [];
}

const outgoing = (node) =>
  (node.children ?? []).map((child, index) => ({ ...child, index, dir: 'out' }));

/**
 * Incoming relations as validate.py records them: for every node child of
 * every node, the target gets a mirror entry. Needed because a repeated
 * relation is counted over outgoing plain roles plus incoming inverted ones.
 */
function incomingByVar(nodes) {
  const incoming = new Map();
  for (const [variable, node] of nodes) {
    outgoing(node).forEach((child) => {
      if (child.kind !== 'node' || !nodes.has(child.value)) return;
      const list = incoming.get(child.value) ?? [];
      list.push({ ...child, dir: 'in', value: variable });
      incoming.set(child.value, list);
    });
  }
  return incoming;
}

// Whether var0 reaches var1, ignoring the two relations UMR allows a cycle
// through (validate.py:587).
function dominates(var0, var1, nodes, tried = new Set()) {
  tried.add(var0);
  const node = nodes.get(var0);
  if (!node) return false;
  for (const child of node.children ?? []) {
    if (child.kind !== 'node') continue;
    if (child.rel === ':quote' || child.rel === ':modal-predicate') continue;
    if (!nodes.has(child.value)) continue;
    if (child.value === var1) return true;
    if (!tried.has(child.value) && dominates(child.value, var1, nodes, tried)) return true;
  }
  return false;
}

/**
 * Which nodes of a sentence are events (validate.py:1583). A discourse
 * connective or a metadata roleset never is; a `-91` roleset, an `:ARGn`
 * child, an `:ARGn-of` parent, `:aspect` or `:modal-strength` all make one.
 */
function detectEvents(sentence, sets, { sameEvent = true } = {}) {
  const nodes = sentence.graph?.nodes ?? new Map();
  const incoming = incomingByVar(nodes);
  const discourse = new Set(DISCOURSE_CONCEPTS[sets] ?? DISCOURSE_CONCEPTS.validator);
  const nonEvent = new Set(NON_EVENT_ROLESETS);
  const events = new Map();
  for (const [variable, node] of nodes) {
    if (discourse.has(node.concept) || nonEvent.has(node.concept)) continue;
    let reason = null;
    if (ROLESET.test(node.concept)) reason = `its concept is ${node.concept}`;
    if (!reason) {
      for (const child of outgoing(node)) {
        // validate.py:1620 lists `:modstr`, the pre-1.0 spelling, not
        // `:modal-strength`, so a node whose only clue is a modal strength is
        // not an event there. Kept as-is so the two agree on what needs
        // `:aspect`.
        if (ARG.test(child.rel) || child.rel === ':aspect' || child.rel === ':modstr') {
          reason = `it has the outgoing relation ${child.rel}`;
          break;
        }
      }
    }
    if (!reason) {
      for (const child of incoming.get(variable) ?? []) {
        if (ARG_OF.test(child.rel)) {
          reason = `it has the incoming relation ${child.rel}`;
          break;
        }
      }
    }
    if (reason) events.set(variable, reason);
  }
  // The document-level :same-event relation says so outright.
  if (!sameEvent) return events;
  for (const [a, relation, b] of sentence.docGraph?.coref ?? []) {
    if (relation !== ':same-event') continue;
    [a, b].forEach((variable) => {
      if (nodes.has(variable) && !events.has(variable)) {
        events.set(variable, 'it participates in a :same-event relation');
      }
    });
  }
  return events;
}

// The edges at which the graph writes a node out, from its own `inline`
// markers where it has them and from the first-visit rule otherwise. This is
// what makes "written before" a well-defined notion for a graph that came out
// of storage rather than out of a file.
function expansionSites(graph) {
  const marked = new Set();
  for (const [variable, node] of graph.nodes) {
    (node.children ?? []).forEach((child, index) => {
      if (child.kind === 'node' && child.inline === true) marked.add(`${variable}\u0000${index}`);
    });
  }
  if (marked.size) return marked;
  return new Set([...treeEdges(graph)].map(([parent, index]) => `${parent}\u0000${index}`));
}

/**
 * The bare references that point at a node written out later in the file.
 * validate.py reports these as unknown ids unless --allow-forward-references;
 * here they are their own finding, because Plaid can always reorder them.
 */
function forwardReferences(graph) {
  const { root, nodes } = graph;
  if (!root || !nodes.has(root)) return [];
  const sites = expansionSites(graph);
  const written = new Set([root]);
  const forward = [];
  const visit = (variable) => {
    (nodes.get(variable)?.children ?? []).forEach((child, index) => {
      if (child.kind !== 'node') return;
      const expandHere =
        nodes.has(child.value) &&
        !written.has(child.value) &&
        sites.has(`${variable}\u0000${index}`);
      if (expandHere) {
        written.add(child.value);
        visit(child.value);
      } else if (nodes.has(child.value) && !written.has(child.value)) {
        forward.push({ variable, child });
      }
    });
  };
  visit(root);
  return forward;
}

function checkGraph(sentence, findings, options) {
  const graph = sentence.graph;
  if (!graph) return;
  const { nodes } = graph;
  const previous = options.previousVars ?? new Set();
  const defined = new Set(nodes.keys());

  for (const [variable, node] of nodes) {
    if (previous.has(variable)) {
      findings.push({
        level: 'error',
        code: 'non-unique-node-id',
        message: `Variable '${variable}' is used twice in the document.`,
        var: variable,
      });
    }
    if (!node.concept) {
      findings.push({
        level: 'error',
        code: 'missing-concept-string',
        message: `Node '${variable}' has no concept.`,
        var: variable,
      });
    }
    if (!VARIABLE.test(variable)) {
      findings.push({
        level: 'warning',
        code: 'invalid-variable',
        message: `Variable '${variable}' is not of the form sNx.`,
        var: variable,
      });
    }
    outgoing(node).forEach((child) => {
      if (child.kind !== 'node') {
        const problem = valueProblem(child);
        if (problem) findings.push({ level: 'error', ...problem, var: variable });
        return;
      }
      if (!defined.has(child.value)) {
        const code = previous.has(child.value) ? 'cross-sentence-reference' : 'unknown-node-id';
        const message = previous.has(child.value)
          ? `Sentence level graph cannot contain nodes from other sentences: '${child.value}'.`
          : `Variable '${child.value}' is not defined in this sentence.`;
        findings.push({ level: 'error', code, message, var: variable });
        return;
      }
      // A cycle is reported where it closes, as validate.py does: at the bare
      // reference back up the graph, not once per node on the ring.
      if (!child.inline && dominates(child.value, child.value, nodes)) {
        findings.push({
          level: 'error',
          code: 'cycle',
          message: `The node '${child.value}' dominates itself. Use inverted relations to prevent cycles.`,
          var: child.value,
        });
      }
    });
  }

  forwardReferences(graph).forEach(({ variable, child }) => {
    findings.push({
      level: 'warning',
      code: 'forward-reference',
      message: `'${variable} ${child.rel} ${child.value}' refers to a node written out later.`,
      var: variable,
    });
  });
}

// What validate.py reads a bare value's front as a reference to a node
// (validate.py:142 tried before the atom), unanchored: `s1x-b` is read as
// `s1x` and a stray `-b`.
const VARIABLE_FRONT = /^s[0-9]+\p{Ll}+[0-9]*/u;

/**
 * Why validate.py cannot read `value`, an attribute's value as it is stored
 * (a string with its quotes, else a bare value), as `{code, message}` with
 * its test id, or null when it reads it. A string holds no quote and no line
 * break and is not empty (validate.py:392 reads a string line by line, up to
 * the next quote). A bare value is an atom of lowercase letters, digits, `+`
 * and `-`, or a number, and does not start like a variable.
 *
 * The editors refuse NEW input with this (ruled 2026-09-28: Text mode Apply,
 * the pickers and rename). An imported value is only reported, by the
 * Validation tab, and the export writes it as it came.
 *
 * @param {string} value
 * @param {string} [rel] the relation it stands under, to name in the message
 * @returns {{code: string, message: string}|null}
 */
export function valueGrammarProblem(value, rel = null) {
  const text = String(value ?? '');
  const of = rel ? ` of '${rel}'` : '';
  if (text.startsWith('"')) {
    const inner = /^"([\s\S]*)"$/.exec(text)?.[1];
    // An unclosed string is the export's refusal (umrFileProblems).
    if (inner === undefined) return null;
    if (/[\r\n\u2028\u2029]/.test(inner)) {
      return {
        code: 'invalid-line',
        message: `The string value${of} runs over more than one line.`,
      };
    }
    if (!inner) {
      return { code: 'missing-node-definition', message: `The string value${of} is empty.` };
    }
    if (inner.includes('"')) {
      return {
        code: 'invalid-sentence-level',
        message: `The string value${of} holds a quote: ${text}`,
      };
    }
    return null;
  }
  const front = VARIABLE_FRONT.exec(text)?.[0];
  if (front) {
    return {
      code: 'invalid-sentence-level',
      message: `The value '${text}'${of} is read as the variable '${front}'. Quote it.`,
    };
  }
  if (ATOM.test(text) || NUMBER.test(text)) return null;
  if (UPPER_ATOM.test(text)) {
    return {
      code: 'value-wrong-chars',
      message: `The value '${text}'${of} holds a capital letter or an underscore.`,
    };
  }
  return {
    code: 'missing-node-definition',
    message: `The value '${text}'${of} is not a number or a word of lowercase letters, digits, + and -.`,
  };
}

const valueProblem = (child) => valueGrammarProblem(child.value, child.rel);

/**
 * Text that is not in Unicode NFC, which the format requires of the whole
 * file (validate.py `unicode-normalization`): each variable, concept and
 * value of the graph, the sentence's words (the first of them only), each
 * interlinear line (its first such item), the sentence text and each
 * metadata line.
 */
function checkNormalization(sentence, findings) {
  const push = (message, variable) =>
    findings.push({
      level: 'error',
      code: 'unicode-normalization',
      message,
      ...(variable ? { var: variable } : {}),
    });
  const off = (text) => typeof text === 'string' && nfc(text) !== text;
  for (const [variable, node] of sentence.graph?.nodes ?? new Map()) {
    if (off(variable)) push(`The variable '${variable}' is not in Unicode NFC.`, variable);
    if (off(node.concept)) {
      push(`The concept '${node.concept}' of '${variable}' is not in Unicode NFC.`, variable);
    }
    for (const child of node.children ?? []) {
      if (child.kind !== 'node' && off(child.value)) {
        push(
          `The value ${child.value} of '${variable} ${child.rel}' is not in Unicode NFC.`,
          variable,
        );
      }
    }
  }
  const word = (sentence.words ?? []).findIndex(off);
  if (word !== -1) {
    push(`Word ${word + 1} ('${sentence.words[word]}') is not in Unicode NFC.`);
  }
  // The other lines the export writes from what is stored: a gloss or a
  // translation typed in IGT, the sentence's text, a metadata line.
  for (const line of sentence.ilg ?? []) {
    if (line.key === 'words') continue;
    const item = (line.items ?? []).find(off);
    if (item !== undefined) push(`The ${line.header} line ('${item}') is not in Unicode NFC.`);
  }
  if (off(sentence.sentenceText)) push('The sentence text is not in Unicode NFC.');
  (sentence.meta ?? []).filter(off).forEach((line) => {
    push(`The metadata line '${line}' is not in Unicode NFC.`);
  });
}

function checkAlignment(sentence, findings, options) {
  const nodes = sentence.graph?.nodes ?? new Map();
  const words = sentence.words ?? [];
  const aligned = new Array(words.length).fill(false);

  for (const [variable, spans] of sentence.alignment ?? new Map()) {
    if (!nodes.has(variable)) {
      findings.push({
        level: 'error',
        code: 'unknown-node-id',
        message: `Alignment of '${variable}': no such node is defined in this sentence.`,
        var: variable,
      });
    }
    let previousEnd = -1;
    for (const [begin, end] of spans) {
      if (end < begin) {
        findings.push({
          level: 'error',
          code: 'invalid-token-range',
          message: `Alignment of '${variable}': ${begin}-${end} runs backwards.`,
          var: variable,
        });
        continue;
      }
      if (begin <= previousEnd + 1 && previousEnd >= 0) {
        findings.push({
          level: 'error',
          code: 'invalid-token-range',
          message: `Alignment of '${variable}': segment ${begin}-${end} must start after ${previousEnd + 1}.`,
          var: variable,
        });
      }
      previousEnd = end;
      if (begin > words.length || end > words.length) {
        findings.push({
          level: 'error',
          code: 'invalid-token-index',
          message: `Alignment of '${variable}': ${begin}-${end} is out of range. There are ${words.length} words.`,
          var: variable,
        });
        continue;
      }
      for (let i = begin; i <= end; i++) {
        if (aligned[i - 1] && options.checkOverlappingAlignment) {
          findings.push({
            level: 'warning',
            code: 'overlapping-alignment',
            message: `Several nodes are aligned to word ${i}.`,
            var: variable,
          });
        }
        aligned[i - 1] = true;
      }
    }
  }

  if (options.checkCompleteAlignment) {
    for (const variable of nodes.keys()) {
      if (!sentence.alignment?.has(variable)) {
        findings.push({
          level: 'error',
          code: 'missing-alignment',
          message: `Missing alignment of node '${variable}'. Even unaligned nodes are marked '0-0'.`,
          var: variable,
        });
      }
    }
  }

  if (options.checkUnalignedToken) {
    words.forEach((word, i) => {
      if (aligned[i] || PUNCTUATION.test(word)) return;
      findings.push({
        level: 'warning',
        code: 'unaligned-token',
        message: `Word ${i + 1} ('${word}') is not aligned to any node.`,
        word: i + 1,
      });
    });
  }
}

function checkDocGraph(sentence, findings, options) {
  const docGraph = sentence.docGraph;
  if (!docGraph) return;
  const nodes = sentence.graph?.nodes ?? new Map();
  const previous = options.previousVars ?? new Set();
  const constants = new Set(DOC_CONSTANTS);
  const sets = options.sets ?? 'validator';

  for (const group of ['temporal', 'modal', 'coref']) {
    for (const [a, relation, b] of docGraph[group] ?? []) {
      const unknown = unknownDocRelationProblem(group, relation, sets);
      if (unknown) {
        findings.push({
          level: 'error',
          code: 'unknown-document-relation',
          message: unknown,
        });
      }
      const place = (variable) =>
        constants.has(variable)
          ? 'constant'
          : nodes.has(variable)
            ? 'current'
            : previous.has(variable)
              ? 'earlier'
              : 'unknown';
      const where = [place(a), place(b)];
      where.forEach((kind, i) => {
        if (kind !== 'unknown') return;
        findings.push({
          level: 'error',
          code: 'unknown-node-id',
          message: `Variable '${[a, b][i]}' is not defined so far.`,
          var: [a, b][i],
        });
      });
      // A sentence's document-level annotation must touch that sentence,
      // except for the fixed constant-only triples (validate.py:1189).
      const constantPair =
        (a === 'root' && b === 'author') ||
        (a === 'author' && (b === 'have-condition-91' || b === 'null-conceiver'));
      if (
        options.checkMisplaced &&
        !constantPair &&
        !where.includes('current') &&
        !where.includes('unknown')
      ) {
        findings.push({
          level: 'error',
          code: 'misplaced-document-relation',
          message: `At least one node of '${a} ${relation} ${b}' must be from this sentence.`,
        });
      }
    }
  }
}

function checkContents(sentence, findings, options) {
  const nodes = sentence.graph?.nodes ?? new Map();
  const sets = options.sets ?? 'validator';
  const incoming = incomingByVar(nodes);

  for (const [variable, node] of nodes) {
    const children = outgoing(node);
    // Unknown relations, and values where a child node was expected.
    children.forEach((child) => {
      const base = uninvert(child.rel);
      const known = knownRelation(child.rel);
      if (!known) {
        findings.push({
          level: 'error',
          code: 'unknown-relation',
          message: unknownRelationProblem(child.rel),
          var: variable,
        });
        return;
      }
      let type = known.type;
      let values = valuesFor(base, sets);
      // A set validate.py itself enforces is closed: an atom outside it and a
      // child node in its place are both wrong. A set that only the
      // guidelines give (`:degree`, `:polarity`) leaves room for a lexical
      // concept, so there only an atom is judged.
      let closed = (known.values ?? []).length > 0;
      // The handful of rolesets whose argument really is an atom
      // (validate.py:1440).
      if (child.rel === ':ARG2' && node.concept === 'have-polarity-91') {
        type = 'attribute';
        values = ['+', '-'];
        closed = true;
      }
      if (
        (child.rel === ':ARG1' && node.concept === 'rate-entity-91') ||
        (child.rel === ':ARG2' && node.concept === 'have-quant-91') ||
        (child.rel === ':ARG2' && node.concept === 'have-modal-strength-91')
      ) {
        type = 'attribute';
        values = [];
      }
      if (type !== 'attribute') {
        if (child.kind !== 'node') {
          findings.push({
            level: 'error',
            code: 'unexpected-value',
            message: `Expected a child node because '${child.rel}' is a relation. Found the ${child.kind} '${child.value}'.`,
            var: variable,
          });
        }
        return;
      }
      const value = child.kind === 'string' ? child.value.replace(/^"|"$/g, '') : child.value;
      if (values.length && (closed || child.kind === 'atom') && !values.includes(value)) {
        findings.push({
          level: 'error',
          code: 'unexpected-value',
          message: `Unexpected value '${value}' of attribute '${child.rel}'.`,
          var: variable,
        });
      }
    });

    // A relation that may not repeat, counted over plain outgoing ones plus
    // inverted incoming ones (validate.py:1462).
    const counts = new Map();
    [...children, ...(incoming.get(variable) ?? [])].forEach((child) => {
      const base = uninvert(child.rel);
      const plainOut = child.dir === 'out' && base === child.rel;
      const invertedIn = child.dir === 'in' && base !== child.rel;
      if (!plainOut && !invertedIn) return;
      counts.set(base, (counts.get(base) ?? 0) + 1);
    });
    for (const [relation, count] of counts) {
      const known = KNOWN_RELATIONS[relation];
      if (count > 1 && known && !known.repeat) {
        findings.push({
          level: 'error',
          code: 'repeated-relation',
          message: `Node '${variable}' has ${count} '${relation}' relations but may have one.`,
          var: variable,
        });
      }
    }

    // :op numbering must have no gap.
    const ops = children
      .map((child) => OP.exec(child.rel)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i] > i + 1) {
        findings.push({
          level: 'error',
          code: 'skipped-op-relation',
          message: `Node '${variable}' has ':op${ops[i]}' but no ':op${ops[i] - 1}'.`,
          var: variable,
        });
        break;
      }
    }

    if (node.concept === 'name') checkName(variable, node, incoming, findings);
    if (options.checkWiki) checkWiki(variable, children, findings);
  }

  checkEvents(sentence, findings, options);
}

function checkName(variable, node, incoming, findings) {
  let hasIncomingName = false;
  (incoming.get(variable) ?? []).forEach((child) => {
    if (child.rel === ':name' || child.rel === ':ARG2') {
      hasIncomingName = true;
      return;
    }
    findings.push({
      level: 'warning',
      code: 'wrong-incoming-name',
      message: `Incoming relation to a 'name' concept should not be '${child.rel}'.`,
      var: variable,
    });
  });
  let hasOp1 = false;
  outgoing(node).forEach((child) => {
    if (!OP.test(child.rel)) {
      findings.push({
        level: 'warning',
        code: 'wrong-outgoing-name',
        message: `Outgoing relation from a 'name' concept should not be '${child.rel}'.`,
        var: variable,
      });
      return;
    }
    if (child.rel === ':op1') hasOp1 = true;
    if (child.kind !== 'string') {
      findings.push({
        level: 'error',
        code: 'unexpected-value',
        message: `Expected a quoted string for '${child.rel}' of a 'name' concept, found ${aKind(child.kind)}.`,
        var: variable,
      });
    }
  });
  if (!hasIncomingName) {
    findings.push({
      level: 'warning',
      code: 'missing-incoming-name',
      message: `Missing incoming ':name' relation to the 'name' concept ${variable}.`,
      var: variable,
    });
  }
  if (!hasOp1) {
    findings.push({
      level: 'warning',
      code: 'missing-outgoing-name',
      message: `Missing outgoing ':op1' relation from the 'name' concept ${variable}.`,
      var: variable,
    });
  }
}

function checkWiki(variable, children, findings) {
  children.forEach((child) => {
    if (child.rel !== ':wiki') return;
    if (child.kind !== 'string') {
      findings.push({
        level: 'error',
        code: 'unexpected-value',
        message: `Expected a quoted string for ':wiki', found ${aKind(child.kind)}.`,
        var: variable,
      });
      return;
    }
    const value = child.value.replace(/^"|"$/g, '');
    if (!WIKIDATA_ID.test(value)) {
      findings.push({
        level: 'error',
        code: 'unexpected-value',
        message: `Expected a Wikidata id (Q + number) for ':wiki', found '${value}'.`,
        var: variable,
      });
    }
  });
}

function checkEvents(sentence, findings, options) {
  if (!options.checkAspectModstr) return;
  const nodes = sentence.graph?.nodes ?? new Map();
  const events = detectEvents(sentence, options.sets ?? 'validator');
  const exempt = new Set([
    ...(DISCOURSE_CONCEPTS[options.sets ?? 'validator'] ?? DISCOURSE_CONCEPTS.validator),
    ...NON_EVENT_ROLESETS,
  ]);

  for (const [variable, node] of nodes) {
    const children = outgoing(node);
    const aspect = children.filter((child) => child.rel === ':aspect');
    const modal = children.filter(
      (child) => child.rel === ':modal-strength' || child.rel === ':modal-predicate',
    );
    if (events.has(variable)) {
      // `event` is the placeholder for a verb that was elided, so its aspect
      // is unknowable (validate.py:1700).
      if (node.concept === 'event') continue;
      if (!aspect.length) {
        findings.push({
          level: 'error',
          code: 'missing-attribute',
          message: `Missing ':aspect'. Node '${variable}' is an event because ${events.get(variable)}.`,
          var: variable,
        });
      }
      const strength = modal[0]?.rel === ':modal-strength' ? modal[0] : null;
      if (options.requireDocumentLevel && strength) {
        findings.push({
          level: 'warning',
          code: 'sentence-level-modal-strength',
          message: `':modal-strength' on '${variable}' is deprecated. Modal annotation belongs in the document graph.`,
          var: variable,
        });
        if (strength.kind !== 'atom') {
          findings.push({
            level: 'error',
            code: 'invalid-attribute',
            message: `':modal-strength' on '${variable}' takes an atom, not ${aKind(strength.kind)}.`,
            var: variable,
          });
        }
      }
      if (options.requireDocumentLevel) {
        const temporal = sentence.docGraph?.temporal ?? [];
        const found = temporal.some(([a, , b]) => a === variable || b === variable);
        if (!found) {
          findings.push({
            level: 'error',
            code: 'missing-temporal',
            message: `Missing a temporal relation for the event '${variable} / ${node.concept}'.`,
            var: variable,
          });
        }
      }
    } else if (exempt.has(node.concept)) {
      // One finding per kind, as validate.py reports :aspect and the modal
      // pair separately.
      [aspect[0], modal[0]].filter(Boolean).forEach((child) => {
        findings.push({
          level: 'error',
          code: 'unexpected-attribute',
          message: `'${child.rel}' is not expected because '${node.concept}' is not an event.`,
          var: variable,
        });
      });
    }
  }
}

/**
 * A node in a :same-event relation must not be an entity, and a node in a
 * :same-entity relation not an event (validate.py:1624). What a node is
 * carries over from sentence to sentence in `kinds`: its shape says it is an
 * event, and each coreference relation, taken in order, says what its two
 * nodes are from then on.
 */
function checkCorefKinds(sentence, findings, options) {
  if (!options.checkCorefEntityEvent) return;
  const { kinds } = options;
  const nodes = sentence.graph?.nodes ?? new Map();
  const previous = options.previousVars ?? new Set();
  detectEvents(sentence, options.sets ?? 'validator', { sameEvent: false }).forEach(
    (reason, variable) => {
      if (!kinds.event.has(variable)) kinds.event.set(variable, reason);
    },
  );
  const RULES = {
    ':same-event': { is: 'event', not: 'entity' },
    ':same-entity': { is: 'entity', not: 'event' },
  };
  for (const [a, relation, b] of sentence.docGraph?.coref ?? []) {
    const rule = RULES[relation];
    if (!rule) continue;
    [a, b].forEach((variable) => {
      if (!nodes.has(variable) && !previous.has(variable)) return;
      const against = kinds[rule.not].get(variable);
      if (against) {
        findings.push({
          level: 'error',
          code: 'coref-entity-event-mismatch',
          message: `'${variable}' cannot be in a ${relation} relation. It is an ${rule.not} because ${against}.`,
          var: variable,
        });
      }
      if (!kinds[rule.is].has(variable)) {
        kinds[rule.is].set(variable, `it is in a ${relation} relation`);
      }
    });
  }
}

/**
 * Nodes in one coreference cluster with different Wikidata ids
 * (validate.py:1849). A cluster is what :same-entity and :same-event join,
 * across the whole document. In each, the members in order of variable are
 * held to the first one with a `:wiki`.
 *
 * @param {Array<object>} sentences
 * @returns {Array<{level, code, message, var, sentence}>}
 */
function corefWikiMismatches(sentences) {
  const where = new Map();
  sentences.forEach((sentence, i) => {
    for (const [variable, node] of sentence.graph?.nodes ?? new Map()) {
      if (!where.has(variable)) where.set(variable, { node, sentence: sentence.index ?? i + 1 });
    }
  });
  const parent = new Map();
  const find = (v) => {
    while (parent.get(v) !== v) v = parent.get(v);
    return v;
  };
  sentences.forEach((sentence) => {
    for (const [a, relation, b] of sentence.docGraph?.coref ?? []) {
      if (relation !== ':same-entity' && relation !== ':same-event') continue;
      if (!where.has(a) || !where.has(b)) continue;
      [a, b].forEach((v) => parent.has(v) || parent.set(v, v));
      parent.set(find(a), find(b));
    }
  });
  const clusters = new Map();
  for (const v of parent.keys()) {
    const root = find(v);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(v);
  }
  const wikiOf = (v) => {
    const child = (where.get(v).node.children ?? []).find((c) => c.rel === ':wiki');
    return child ? String(child.value).replace(/^"|"$/g, '') : '';
  };
  const findings = [];
  for (const members of clusters.values()) {
    let first = null;
    for (const v of members.sort()) {
      const wiki = wikiOf(v);
      if (!wiki) continue;
      if (!first) {
        first = { v, wiki };
        continue;
      }
      if (wiki !== first.wiki) {
        findings.push({
          level: 'error',
          code: 'coref-wiki-mismatch',
          message: `'${v}' has the Wikidata id ${wiki}, and it corefers with '${first.v}', whose Wikidata id is ${first.wiki}.`,
          var: v,
          sentence: where.get(v).sentence,
        });
      }
    }
  }
  return findings;
}

const DEFAULTS = {
  sets: 'validator',
  previousVars: new Set(),
  checkCompleteAlignment: true,
  checkUnalignedToken: true,
  checkOverlappingAlignment: false,
  checkWiki: true,
  checkAspectModstr: true,
  requireDocumentLevel: true,
  checkMisplaced: true,
  checkCorefEntityEvent: true,
};

/**
 * Check one sentence.
 *
 * @param {object} sentence a sentence as parseUmrFile produces it
 * @param {object} [options] `previousVars` is the set of variables defined in
 *   earlier sentences; `sets` picks the 'validator' (default) or 'schema'
 *   inventory; the `check*` flags mirror validate.py's relaxing options.
 * @returns {Array<{level: 'error'|'warning', code: string, message: string, var?: string}>}
 */
export function validateSentence(sentence, options = {}) {
  const settings = {
    ...DEFAULTS,
    kinds: { event: new Map(), entity: new Map() },
    ...options,
  };
  const findings = [];
  checkNormalization(sentence, findings);
  checkGraph(sentence, findings, settings);
  checkAlignment(sentence, findings, settings);
  checkDocGraph(sentence, findings, settings);
  checkContents(sentence, findings, settings);
  checkCorefKinds(sentence, findings, settings);
  return findings;
}

/**
 * Check a whole document: every sentence in order, each one seeing the
 * variables the earlier ones defined, so that a cross-sentence reference and
 * a document-level relation that touches no current node are both caught.
 *
 * Coreference is checked across the document as well: a node's kind (event or
 * entity) against the coreference relations it is in, and `:wiki` agreement
 * within a cluster. Not checked yet: temporal contradictions
 * (`temporal-mismatch`), which validate.py infers over the whole temporal
 * graph.
 *
 * @param {Array<object>} sentences
 * @param {object} [options] as validateSentence, plus nothing else
 * @returns {Array<{level, code, message, var?, sentence: number}>}
 */
export function validateDocument(sentences, options = {}) {
  const findings = [];
  const previousVars = new Set();
  const kinds = { event: new Map(), entity: new Map() };
  (sentences ?? []).forEach((sentence, i) => {
    validateSentence(sentence, { ...options, previousVars, kinds }).forEach((finding) => {
      findings.push({ ...finding, sentence: sentence.index ?? i + 1 });
    });
    for (const variable of sentence.graph?.nodes.keys() ?? []) previousVars.add(variable);
    if (sentence.docGraph?.var) previousVars.add(sentence.docGraph.var);
  });
  if ({ ...DEFAULTS, ...options }.checkWiki) findings.push(...corefWikiMismatches(sentences ?? []));
  return findings;
}
