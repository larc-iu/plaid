// A port of umrtools/validate.py's levels 1 to 3, minus the checks that are
// about lines rather than meaning.
//
// Left out on purpose: the file-format tests (trailing whitespace, block
// counts, empty lines, NFC) and the interlinear-glossing tests, because Plaid
// stores structure and regenerates the lines. What is kept is everything that
// judges the graph: the sentence graph, the alignment, the document graph and
// the level-3 contents checks. Each finding carries validate.py's own test id
// as `code`, so a message here can be traced to the line it came from.

import {
  ATTRIBUTES,
  DOC_CONSTANTS,
  DOC_RELATIONS,
  DISCOURSE_CONCEPTS,
  KNOWN_RELATIONS,
  NON_EVENT_ROLESETS,
} from './inventory.js';
import { treeEdges } from './penman.js';

const OP = /^:op([1-9][0-9]*)$/;
const VARIABLE = /^s[0-9]+\p{Ll}+[0-9]*$/u;
const PUNCTUATION = /^\p{P}+$/u;
const WIKIDATA_ID = /^Q[1-9][0-9]*$/;
const ROLESET = /^.+-91$/;
const ARG = /^:ARG[0-6]$/;
const ARG_OF = /^:ARG[0-6]-of$/;

const uninvert = (relation) => relation.replace(/-of$/, '');

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
function detectEvents(sentence, sets) {
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
        message: `The node id (variable) '${variable}' is not unique in the document.`,
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
        message: `The node id (variable) '${variable}' does not follow the sNx convention.`,
        var: variable,
      });
    }
    outgoing(node).forEach((child) => {
      if (child.kind !== 'node') return;
      if (!defined.has(child.value)) {
        const code = previous.has(child.value) ? 'cross-sentence-reference' : 'unknown-node-id';
        const message = previous.has(child.value)
          ? `Sentence level graph cannot contain nodes from other sentences: '${child.value}'.`
          : `The node id (variable) '${child.value}' is unknown. No such node is defined in this sentence.`;
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
          message: `Alignment of '${variable}': ${begin}-${end} is out of range; there are ${words.length} words.`,
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
    const known = new Set(DOC_RELATIONS[group][sets] ?? DOC_RELATIONS[group].validator);
    for (const [a, relation, b] of docGraph[group] ?? []) {
      if (!known.has(relation)) {
        findings.push({
          level: 'error',
          code: 'unknown-document-relation',
          message: `Unknown document-level ${group} relation '${relation}'.`,
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
          message: `The node id (variable) '${[a, b][i]}' is unknown. No such node has been defined so far.`,
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
      const known = KNOWN_RELATIONS[base] ?? (OP.test(base) ? KNOWN_RELATIONS[':op1'] : null);
      if (!known) {
        findings.push({
          level: 'error',
          code: 'unknown-relation',
          message: `Unknown relation '${child.rel}'.`,
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
            message: `Expected a child node because '${child.rel}' is a relation; found the ${child.kind} '${child.value}'.`,
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
        message: `Expected a quoted string for '${child.rel}' of a 'name' concept, found a ${child.kind}.`,
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
        message: `Expected a quoted string for ':wiki', found a ${child.kind}.`,
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
          message: `':modal-strength' on '${variable}' is deprecated; modal annotation belongs in the document graph.`,
          var: variable,
        });
        if (strength.kind !== 'atom') {
          findings.push({
            level: 'error',
            code: 'invalid-attribute',
            message: `':modal-strength' on '${variable}' takes an atom, not a ${strength.kind}.`,
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
  const settings = { ...DEFAULTS, ...options };
  const findings = [];
  checkGraph(sentence, findings, settings);
  checkAlignment(sentence, findings, settings);
  checkDocGraph(sentence, findings, settings);
  checkContents(sentence, findings, settings);
  return findings;
}

/**
 * Check a whole document: every sentence in order, each one seeing the
 * variables the earlier ones defined, so that a cross-sentence reference and
 * a document-level relation that touches no current node are both caught.
 *
 * Left for later, as validate.py does them document-wide: coreference cluster
 * consistency, `:wiki` agreement within a cluster, and temporal contradictions.
 *
 * @param {Array<object>} sentences
 * @param {object} [options] as validateSentence, plus nothing else
 * @returns {Array<{level, code, message, var?, sentence: number}>}
 */
export function validateDocument(sentences, options = {}) {
  const findings = [];
  const previousVars = new Set();
  (sentences ?? []).forEach((sentence, i) => {
    validateSentence(sentence, { ...options, previousVars }).forEach((finding) => {
      findings.push({ ...finding, sentence: sentence.index ?? i + 1 });
    });
    for (const variable of sentence.graph?.nodes.keys() ?? []) previousVars.add(variable);
    if (sentence.docGraph?.var) previousVars.add(sentence.docGraph.var);
  });
  return findings;
}
