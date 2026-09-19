// The .umr file: a sequence of sentences, each four blocks — tokens, sentence
// level graph, alignment, document level graph — separated by a line of 80 '#'
// (docs/umr/umr-file-format.md).
//
// Reading is deliberately more forgiving than umrtools/validate.py, because
// every released corpus breaks the spec somewhere: the English file puts two
// empty lines between blocks, three files have no '# :: sntN' line at all,
// Arapaho and Sanapaná use interlinear headers that predate the standard,
// Navajo writes 'sNv :0-0' with the space on the wrong side of the colon, and
// Sanapaná still has UMR 1.0's '-1--1' for unaligned. Each tolerance used
// leaves a warning behind, and writing always produces the modern spelling.

import { parsePenman, serializePenman } from './penman.js';

const SEPARATOR = '#'.repeat(80);

// Block headers, matched loosely so that spacing and a missing colon still
// find the block, and compared against the canonical spelling for a warning.
const BLOCK_HEADERS = [
  {
    key: 'graph',
    canonical: '# sentence level graph:',
    re: /^#\s*sentence\s+level\s+graph\s*:?\s*$/i,
  },
  { key: 'alignment', canonical: '# alignment:', re: /^#\s*alignment\s*:?\s*$/i },
  {
    key: 'doc',
    canonical: '# document level annotation:',
    re: /^#\s*document\s+level\s+(annotation|graph)\s*:?\s*$/i,
  },
];

const SENT_ID = /^#\s*::\s*snt([0-9]+)(?:\s+(.*))?$/;

// Language names the obsolete headers spell out, and the ISO codes they mean.
const LANGUAGE_CODES = {
  english: 'en',
  spanish: 'es',
  portuguese: 'pt',
  chinese: 'zh',
  french: 'fr',
};

const languageCode = (text) => {
  const value = String(text).trim();
  if (/^[a-z]{2,3}$/.test(value)) return value;
  return LANGUAGE_CODES[value.toLowerCase()] ?? null;
};

// The modern headers (validate.py:123). Everything else that is recognized is
// obsolete and is upgraded when the file is written back.
const MODERN = [
  [/^Index$/, 'index', null],
  [/^Words$/, 'words', null],
  [/^Word Gloss \(([a-z]{2,3})\)$/, 'word-gloss', 1],
  [/^Part of Speech$/, 'pos', null],
  [/^Morphemes$/, 'morphemes', null],
  [/^Morpheme Gloss \(([a-z]{2,3})\)$/, 'morpheme-gloss', 1],
  [/^Morpheme Category$/, 'morpheme-category', null],
  [/^Sentence$/, 'sentence', null],
  [/^Sentence Gloss \(([a-z]{2,3})\)$/, 'sentence-gloss', 1],
];

// The headers the released corpora actually use (validate.py:124 plus the
// Arapaho and Sanapaná spellings it does not cover).
const OBSOLETE = [
  [/^tx$/, 'words', null],
  [/^mb$/, 'morphemes', null],
  [/^ge$/, 'morpheme-gloss', null],
  [/^ps$/, 'pos', null],
  [/^tr$/, 'sentence-gloss', null],
  [/^Morpheme Gloss\s*\(([^)]+)\)$/, 'morpheme-gloss', 1],
  [/^Morphemes\s*\(([^)]+)\)$/, 'morpheme-gloss', 1],
  [/^Morpheme Cat$/, 'morpheme-category', null],
  [/^Word Gloss\s*\(([^)]+)\)$/, 'word-gloss', 1],
  [/^Word Gloss$/, 'word-gloss', null],
  [/^Translation\s*\(([^)]+)\)$/, 'sentence-gloss', 1],
  [/^Sentence Gloss\s*\(([^)]+)\)$/, 'sentence-gloss', 1],
  [/^([A-Za-z]+) Sent Gloss$/, 'sentence-gloss', 1],
  [/^Part of Speech$/, 'pos', null],
];

function classifyHeader(header) {
  const text = header.trim();
  for (const [re, key, group] of MODERN) {
    const match = re.exec(text);
    if (match) return { key, lang: group === null ? null : match[group], obsolete: false };
  }
  for (const [re, key, group] of OBSOLETE) {
    const match = re.exec(text);
    if (match) {
      return { key, lang: group === null ? null : languageCode(match[group]), obsolete: true };
    }
  }
  return { key: 'other', lang: null, obsolete: false };
}

// A gloss line's modern header needs a language code. Where the obsolete
// header carried none, 'und' (ISO 639-3 for undetermined) says so rather than
// guessing, and keeps the written line inside the standard's grammar.
const GLOSS_KEYS = new Set(['word-gloss', 'morpheme-gloss', 'sentence-gloss']);

const MODERN_HEADERS = {
  index: 'Index',
  words: 'Words',
  'word-gloss': 'Word Gloss',
  pos: 'Part of Speech',
  morphemes: 'Morphemes',
  'morpheme-gloss': 'Morpheme Gloss',
  'morpheme-category': 'Morpheme Category',
  sentence: 'Sentence',
  'sentence-gloss': 'Sentence Gloss',
};

/** The header to write for an interlinear line, upgrading an obsolete one. */
export function modernHeader(line) {
  const base = MODERN_HEADERS[line.key];
  if (!base) return line.header;
  if (!GLOSS_KEYS.has(line.key)) return base;
  return `${base} (${line.lang || 'und'})`;
}

const RANGE = /^([0-9]+)-([0-9]+)$/;

function parseAlignmentValue(text, warn, variable) {
  const spans = [];
  for (const piece of text.split(',')) {
    const value = piece.trim();
    if (value === '0-0' || value === '') continue;
    if (value === '-1--1') {
      warn('legacy-unaligned', `Alignment '-1--1' of '${variable}' is UMR 1.0 for unaligned.`);
      continue;
    }
    const match = RANGE.exec(value);
    if (!match) {
      warn('invalid-token-range', `Cannot read the token range '${value}' of '${variable}'.`);
      continue;
    }
    spans.push([Number(match[1]), Number(match[2])]);
  }
  return spans;
}

/**
 * The alignment block: each line a variable, a colon and the word ranges it
 * covers. Exported so that mending a sentence the parser kept as text can
 * anchor the nodes it writes to the words the file named.
 *
 * @param {string[]|string} block the block's lines, or its text
 * @param {(code: string, message: string) => void} [warn]
 * @returns {Map<string, Array<[number, number]>>}
 */
export function readAlignment(block, warn = () => {}) {
  const lines = Array.isArray(block) ? block : String(block ?? '').split('\n');
  const alignment = new Map();
  for (const line of lines) {
    if (isBlank(line)) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      warn('invalid-alignment', `Alignment line without a colon: '${trimmed}'.`);
      continue;
    }
    const variable = trimmed.slice(0, colon).trim();
    if (/\s/.test(trimmed.slice(0, colon))) {
      warn(
        'alignment-space-before-colon',
        `Alignment of '${variable}' has a space before the colon.`,
      );
    }
    if (alignment.has(variable)) {
      warn('duplicate-alignment', `Repeated alignment of node '${variable}'.`);
    }
    alignment.set(variable, parseAlignmentValue(trimmed.slice(colon + 1), warn, variable));
  }
  return alignment;
}

// The triples inside one relation group. Read by brackets rather than by
// position, because Kukama writes '(past-reference / past-reference
// :contained s2m)' — a triple carrying a concept it does not need. Taking the
// relation as the anchor keeps the two nodes around it.
function triplesFrom(slice, group, warn) {
  const triples = [];
  let j = 0;
  while (j < slice.length) {
    if (slice[j] !== '(') {
      warn('invalid-document-level', `Stray token '${slice[j]}' in the '${group}' group.`);
      j++;
      continue;
    }
    j++;
    const parts = [];
    let depth = 1;
    while (j < slice.length) {
      if (slice[j] === '(') depth++;
      else if (slice[j] === ')' && --depth === 0) {
        j++;
        break;
      } else parts.push(slice[j]);
      j++;
    }
    const at = parts.findIndex((part) => part.startsWith(':'));
    if (at <= 0 || at === parts.length - 1) {
      warn('invalid-document-level', `Cannot read a '${group}' triple from '${parts.join(' ')}'.`);
      continue;
    }
    triples.push([parts[at - 1], parts[at], parts[at + 1]]);
  }
  return triples;
}

// The document-level block is its own little grammar: one node per sentence
// whose "relations" are labelled groups of bracketed triples.
function parseDocGraph(text, warn) {
  const tokens = text.match(/\(|\)|[^\s()]+/g);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  const peek = () => tokens[i];

  // The token run inside the brackets that start here, brackets balanced.
  const balanced = () => {
    const start = ++i;
    let depth = 1;
    while (i < tokens.length) {
      if (tokens[i] === '(') depth++;
      else if (tokens[i] === ')' && --depth === 0) break;
      i++;
    }
    const slice = tokens.slice(start, i);
    if (tokens[i] === ')') i++;
    else
      warn('missing-closing-bracket', 'The document level graph ends without a closing bracket.');
    return slice;
  };

  if (peek() !== '(') {
    warn('invalid-document-level', `Expected the opening bracket, found '${peek()}'.`);
    return null;
  }
  i++;
  const variable = peek();
  i++;
  if (!/^s[0-9]+s0$/.test(String(variable))) {
    warn(
      'invalid-document-level',
      `Document-level variable '${variable}' is not of the form sNs0.`,
    );
  }
  if (peek() === '/') i++;
  else warn('invalid-document-level', "Expected '/' after the document-level variable.");
  if (peek() === 'sentence') i++;
  else warn('missing-sentence-concept', `Expected the concept 'sentence', found '${peek()}'.`);

  const graph = { var: variable, temporal: [], modal: [], coref: [] };
  while (i < tokens.length && peek() !== ')') {
    const group = String(peek());
    i++;
    const bucket = /^:(temporal|modal|coref)$/.test(group) ? graph[group.slice(1)] : null;
    if (!bucket) {
      warn('unknown-document-relation-group', `Unknown document-level relation group '${group}'.`);
    }
    if (peek() !== '(') {
      warn('invalid-document-level', `Expected the bracketed '${group}' group.`);
      continue;
    }
    const triples = triplesFrom(balanced(), group, warn);
    if (bucket) bucket.push(...triples);
  }
  return graph;
}

const isBlank = (line) => line.trim() === '';

function trimBlankEnds(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

/**
 * Read a .umr file.
 *
 * @param {string} text
 * @returns {{ sentences: Array<object>, warnings: Array<{code: string, message: string, sentence: number|null}>, errors: Array<{code: string, message: string, sentence: number|null}> }}
 */
export function parseUmrFile(text) {
  const warnings = [];
  const errors = [];
  let currentSentence = null;
  const warn = (code, message) => warnings.push({ code, message, sentence: currentSentence });
  const error = (code, message) => errors.push({ code, message, sentence: currentSentence });

  const lines = String(text ?? '').split('\n');
  const chunks = [];
  let preamble = [];
  let current = null;
  for (const line of lines) {
    if (/^#{3,}\s*$/.test(line)) {
      if (line.trimEnd() !== SEPARATOR) {
        warn('sentence-separator-width', 'A sentence separator is not exactly 80 hashes.');
      }
      current = [];
      chunks.push(current);
      continue;
    }
    if (current) current.push(line);
    else preamble.push(line);
  }
  if (preamble.some((line) => !isBlank(line))) {
    warn(
      'content-before-first-sentence',
      'Content before the first sentence separator was ignored.',
    );
  }

  const sentences = [];
  chunks.forEach((chunk) => {
    // A file may end with a separator and nothing after it (the Chinese
    // corpus does); that is not a sentence.
    if (!chunk.some((line) => !isBlank(line))) return;
    currentSentence = sentences.length + 1;
    sentences.push(parseSentence(chunk, currentSentence, warn, error));
  });
  currentSentence = null;

  return { sentences, warnings, errors };
}

function splitBlocks(chunk, warn) {
  const bounds = {};
  chunk.forEach((line, index) => {
    if (!line.trimStart().startsWith('#')) return;
    for (const header of BLOCK_HEADERS) {
      if (bounds[header.key] !== undefined) continue;
      if (header.re.test(line.trim())) {
        if (line.trim() !== header.canonical) {
          warn(
            'nonstandard-block-header',
            `Block header '${line.trim()}' is not '${header.canonical}'.`,
          );
        }
        bounds[header.key] = index;
      }
    }
  });
  for (const header of BLOCK_HEADERS) {
    if (bounds[header.key] === undefined) {
      warn('missing-block-header', `Missing the '${header.canonical}' header.`);
    }
  }
  const at = (key, fallback) => (bounds[key] === undefined ? fallback : bounds[key]);
  const graphAt = at('graph', chunk.length);
  const alignAt = at('alignment', graphAt);
  const docAt = at('doc', alignAt);
  return {
    tokens: chunk.slice(0, graphAt),
    graph: chunk.slice(Math.min(graphAt + 1, chunk.length), alignAt),
    alignment: chunk.slice(Math.min(alignAt + 1, chunk.length), docAt),
    doc: chunk.slice(Math.min(docAt + 1, chunk.length)),
  };
}

function parseSentence(chunk, index, warn, error) {
  const blocks = splitBlocks(chunk, warn);

  let snt = null;
  let sentenceText = '';
  const meta = [];
  const ilg = [];
  for (const line of blocks.tokens) {
    if (isBlank(line)) continue;
    const trimmed = line.trimEnd();
    if (trimmed.trimStart().startsWith('#')) {
      const match = SENT_ID.exec(trimmed.trim());
      if (match) {
        if (snt !== null) warn('multiple-sent-id', 'More than one sentence id in the token block.');
        snt = Number(match[1]);
        sentenceText = (match[2] ?? '').trim();
        continue;
      }
      meta.push(trimmed);
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      warn('invalid-ilg', `Token-block line without a header: '${trimmed.trim()}'.`);
      continue;
    }
    const header = trimmed.slice(0, colon);
    const kind = classifyHeader(header);
    if (kind.obsolete) {
      warn('obsolete-ilg', `Obsolete interlinear glossing header '${header.trim()}'.`);
    } else if (kind.key === 'other') {
      warn('unknown-ilg', `Unknown interlinear glossing header '${header.trim()}'.`);
    }
    const value = trimmed.slice(colon + 1).trim();
    ilg.push({
      header: header.trim(),
      key: kind.key,
      lang: kind.lang,
      items: value === '' ? [] : value.split(/\s+/),
    });
  }
  if (snt === null) {
    warn('missing-sent-id', 'No sentence id line; the position in the file is used instead.');
    snt = index;
  }
  const words = ilg.find((line) => line.key === 'words')?.items ?? [];
  if (!words.length) warn('missing-words', 'No Words line in the token block.');

  const graphText = trimBlankEnds(blocks.graph).join('\n');
  let graph = null;
  if (graphText.trim() !== '') {
    graph = parsePenman(graphText);
    graph.errors.forEach((e) =>
      error('sentence-graph', `${e.message} (line ${e.line}, column ${e.col})`),
    );
  }

  const alignment = readAlignment(blocks.alignment, warn);

  const docText = trimBlankEnds(blocks.doc.filter((line) => !line.trim().startsWith('#'))).join(
    '\n',
  );
  const docGraph = docText.trim() === '' ? null : parseDocGraph(docText, warn);

  return {
    index,
    snt,
    sentenceText,
    meta,
    ilg,
    words,
    graph,
    alignment,
    docGraph,
    raw: {
      tokens: trimBlankEnds(blocks.tokens).join('\n'),
      graph: graphText,
      alignment: trimBlankEnds(blocks.alignment).join('\n'),
      doc: docText,
    },
  };
}

function ilgLinesToWrite(sentence) {
  const given = sentence.ilg ?? [];
  const words = sentence.words ?? [];
  const index = given.find((line) => line.key === 'index') ?? {
    key: 'index',
    lang: null,
    header: 'Index',
    items: words.map((_, i) => String(i + 1)),
  };
  const wordsLine = given.find((line) => line.key === 'words') ?? {
    key: 'words',
    lang: null,
    header: 'Words',
    items: words,
  };
  const rest = given.filter((line) => line.key !== 'index' && line.key !== 'words');
  // A line with nothing on it is dropped: the standard's grammar requires at
  // least one item after the header, and an empty gloss carries no annotation.
  return [index, wordsLine, ...rest].filter((line) => (line.items ?? []).length > 0);
}

const formatSpans = (spans) =>
  !spans || !spans.length ? '0-0' : spans.map(([begin, end]) => `${begin}-${end}`).join(',');

function serializeAlignment(sentence) {
  const alignment = sentence.alignment ?? new Map();
  const lines = [];
  const written = new Set();
  const nodes = sentence.graph?.nodes;
  if (nodes) {
    for (const variable of nodes.keys()) {
      written.add(variable);
      lines.push(`${variable}: ${formatSpans(alignment.get(variable))}`);
    }
  }
  for (const [variable, spans] of alignment) {
    if (written.has(variable)) continue;
    lines.push(`${variable}: ${formatSpans(spans)}`);
  }
  return lines;
}

function serializeDocGraph(docGraph) {
  if (!docGraph) return [];
  const groups = ['temporal', 'modal', 'coref'].filter((name) => (docGraph[name] ?? []).length);
  const variable = docGraph.var ?? 's0s0';
  if (!groups.length) return [`(${variable} / sentence)`];
  const lines = [`(${variable} / sentence`];
  groups.forEach((name, groupIndex) => {
    const triples = docGraph[name].map(([a, rel, b]) => `(${a} ${rel} ${b})`);
    const last = groupIndex === groups.length - 1;
    triples.forEach((triple, i) => {
      const head = i === 0 ? `    :${name} (${triple}` : `        ${triple}`;
      const closing = i === triples.length - 1 ? (last ? '))' : ')') : '';
      lines.push(head + closing);
    });
  });
  return lines;
}

/**
 * Write sentences back as a .umr file, in the shape the standard prescribes:
 * 80 hashes, the four blocks in order with their header comments, one empty
 * line after each block and two after the last.
 *
 * @param {{sentences: Array<object>}} document
 * @returns {string}
 */
export function serializeUmrFile({ sentences }) {
  const out = [];
  (sentences ?? []).forEach((sentence) => {
    out.push(SEPARATOR);
    (sentence.meta ?? []).forEach((line) => out.push(line));
    const text = (sentence.sentenceText ?? '').trim();
    out.push(`# :: snt${sentence.snt ?? sentence.index}${text ? `\t${text}` : ''}`);
    const ilg = ilgLinesToWrite(sentence);
    const width = Math.max(0, ...ilg.map((line) => modernHeader(line).length + 1));
    ilg.forEach((line) => {
      out.push(`${`${modernHeader(line)}:`.padEnd(width + 1)}${line.items.join(' ')}`);
    });
    out.push('');

    // A graph kept as text (one the parser could not read) is written back
    // as it was, alignment block included.
    out.push('# sentence level graph:');
    if (typeof sentence.rawGraph === 'string') {
      if (sentence.rawGraph) out.push(...sentence.rawGraph.split('\n'));
    } else {
      const graph = sentence.graph ? serializePenman(sentence.graph) : '';
      if (graph) out.push(...graph.split('\n'));
    }
    out.push('');

    out.push('# alignment:');
    if (typeof sentence.rawGraph === 'string') {
      if (sentence.rawAlignment) out.push(...sentence.rawAlignment.split('\n'));
    } else {
      out.push(...serializeAlignment(sentence));
    }
    out.push('');

    out.push('# document level annotation:');
    out.push(...serializeDocGraph(sentence.docGraph));
    out.push('');
    out.push('');
  });
  return out.length ? `${out.join('\n')}\n` : '';
}
