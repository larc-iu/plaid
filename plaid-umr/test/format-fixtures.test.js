// The seven released UMR corpora, read and written back.
//
// They are the real thing, warts and all: three of them contain PENMAN that no
// parser can make sense of (a doubled opening bracket, an unterminated string,
// a node with two slashes) and several carry references to variables that were
// never defined. Those defects are named below rather than papered over, so
// that a new parse error in a fixture shows up as a failure instead of being
// absorbed by a tolerance.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseUmrFile, serializeUmrFile } from '../src/domain/format/umrFile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'umr');
const VALIDATOR = path.join(
  os.homedir(),
  '.claude/projects/-home-luke-local-plaid/docs/umr/umrtools/validate.py',
);

// The sentences whose graphs the corpora themselves got wrong, and what is
// wrong with each. Every other sentence must parse without an error.
const KNOWN_BAD = {
  'arapaho_umr-0001.umr': {
    36: 'refers to s36e, which is never defined',
    55: "':ARG2 ((s55a2 / animal' has one bracket too many",
    61: 'refers to s60p, a node of the previous sentence',
    107: 'refers to s107h, which is never defined',
    134: 'refers to s34p2, a typo for s134p2',
    159: 'refers to s158p, a node of the previous sentence',
    171: 'refers to s170h2, a node of a previous sentence',
    186: 'refers to s185p, a node of the previous sentence',
    236: 'refers to s235p, and the graph closes before :purpose',
  },
  'chinese_tlp_chapter2.umr': {
    3: "'(s3x18 / 个 / 这)' has two concepts",
    21: "'(s21x11 / 个 / 这)' has two concepts",
    28: 's28x2 is defined twice',
  },
  'sanapana_umr-0001.umr': {
    37: ':wiki "Río_Verde_Paraguay is missing its closing quote',
  },
};

const fixtures = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.umr'));

const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

describe('the released corpora parse', () => {
  fixtures.forEach((name) => {
    test(name, () => {
      const text = read(name);
      const { sentences, errors } = parseUmrFile(text);
      // Three corpora have no '# :: sntN' line at all, so the separator is
      // the only reliable count. The Chinese file ends with a separator and
      // nothing after it, which is not a sentence.
      const separators = text.split('\n').filter((line) => /^#{80}$/.test(line.trimEnd())).length;
      const trailing = /#{80}\s*$/.test(text) ? 1 : 0;
      assert.equal(sentences.length, separators - trailing);

      const sntLines = text.split('\n').filter((line) => /^#\s*::\s*snt[0-9]+/.test(line)).length;
      if (sntLines) assert.equal(sentences.length, sntLines);

      const bad = KNOWN_BAD[name] ?? {};
      const unexpected = errors.filter((e) => !(e.sentence in bad));
      assert.deepEqual(unexpected, [], `unexpected parse errors in ${name}`);
      // A named defect that has gone away means this list is stale.
      const errored = new Set(errors.map((e) => e.sentence));
      Object.keys(bad).forEach((index) => {
        assert.ok(
          errored.has(Number(index)),
          `${name} sentence ${index} no longer fails: ${bad[index]}`,
        );
      });
    });
  });
});

// Everything the file format carries, in a shape deepEqual can compare. The
// interlinear header and its language code are left out on purpose: an
// obsolete header is upgraded when the file is written, which is the point.
function normalize(sentence) {
  return {
    snt: sentence.snt,
    sentenceText: sentence.sentenceText,
    meta: sentence.meta,
    words: sentence.words,
    ilg: (sentence.ilg ?? [])
      .filter((line) => line.items.length)
      .map((line) => [line.key, line.items]),
    graph: sentence.graph
      ? {
          root: sentence.graph.root,
          nodes: [...sentence.graph.nodes.values()].map((node) => [
            node.var,
            node.concept,
            node.children.map((child) => [child.rel, child.kind, child.value]),
          ]),
        }
      : null,
    alignment: [...(sentence.alignment ?? new Map())]
      .filter(([, spans]) => spans.length)
      .sort()
      .map(([variable, spans]) => [variable, spans]),
    docGraph: sentence.docGraph
      ? {
          var: sentence.docGraph.var,
          temporal: sentence.docGraph.temporal,
          modal: sentence.docGraph.modal,
          coref: sentence.docGraph.coref,
        }
      : null,
  };
}

describe('parse, write, parse again', () => {
  fixtures.forEach((name) => {
    test(name, () => {
      const first = parseUmrFile(read(name));
      const written = serializeUmrFile(first);
      const second = parseUmrFile(written);
      assert.equal(second.sentences.length, first.sentences.length);
      // Where a node is written out is part of the file, so a second pass
      // must produce byte-identical text.
      assert.equal(serializeUmrFile(second), written, `${name} is not stable on a second write`);
      const bad = KNOWN_BAD[name] ?? {};
      first.sentences.forEach((sentence, i) => {
        // A sentence whose graph could not be read loses whatever the parser
        // could not attach to the root; there is nothing to round-trip.
        if (sentence.index in bad) return;
        assert.deepEqual(
          normalize(second.sentences[i]),
          normalize(sentence),
          `${name} sentence ${sentence.index}`,
        );
      });
    });
  });
});

// The official validator, run over the original and over what we write. It
// needs the third-party `regex` module, so the interpreter is found rather
// than assumed.
function findPython() {
  const candidates = [
    process.env.UMR_PYTHON,
    'python3',
    path.join(os.homedir(), '.mambaforge/bin/python3'),
    path.join(os.homedir(), 'mambaforge/bin/python3'),
    path.join(os.homedir(), 'miniforge3/bin/python3'),
    path.join(os.homedir(), 'miniconda3/bin/python3'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'import regex'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// The most permissive set of relaxations the validator offers. Even with all
// of them the originals fail, because the block-structure errors have no flag;
// what matters is that what we write fails less.
const FLAGS = [
  '--level',
  '2',
  '--max-err',
  '0',
  '--allow-trailing-whitespace',
  '--allow-wide-space',
  '--no-check-ilg',
  '--allow-forward-references',
  '--allow--1',
  '--optional-block-headers',
  '--optional-alignments',
  '--no-warn-unaligned-token',
  '--no-check-wiki',
  '--optional-aspect-modstr',
  '--allow-duplicate-roles',
  '--allow-cycles',
  '--allow-coref-entity-event-mismatch',
  '--optional-document-level',
];

function countErrors(python, file) {
  // The verdict goes to stderr and the findings to stdout, so both are
  // captured; a failing file also exits non-zero.
  const run = spawnSync(python, [VALIDATOR, ...FLAGS, file], { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (/\*\*\* PASSED \*\*\*/.test(output)) return 0;
  const failed = /\*\*\* FAILED \*\*\* with (\d+) errors/.exec(output);
  if (failed) return Number(failed[1]);
  throw new Error(`Could not read a verdict from the validator:\n${output.slice(0, 2000)}`);
}

describe('the official validator', () => {
  let python = null;
  let workDir = null;

  before(() => {
    if (!fs.existsSync(VALIDATOR)) return;
    python = findPython();
    if (python) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umr-oracle-'));
  });

  fixtures.forEach((name) => {
    test(name, (t) => {
      if (!fs.existsSync(VALIDATOR)) {
        t.skip(`umrtools/validate.py is not at ${VALIDATOR}`);
        return;
      }
      if (!python) {
        t.skip("no python3 with the 'regex' module; set UMR_PYTHON to one");
        return;
      }
      const written = path.join(workDir, name);
      fs.writeFileSync(written, serializeUmrFile(parseUmrFile(read(name))));
      const before_ = countErrors(python, path.join(FIXTURES, name));
      const after = countErrors(python, written);
      assert.ok(
        after <= before_,
        `${name}: the file we write has ${after} validator errors, the original ${before_}`,
      );
    });
  });
});
