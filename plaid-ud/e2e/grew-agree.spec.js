import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, readToken, CORE } from './fixtures.js';
import { PlaidClient } from '@larc-iu/plaid-client';
import { createUdProject } from '../src/domain/udProjectSetup.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { parse } from '../src/grew/parser.js';
import { compileGrew } from '../src/grew/compile.js';
import { GrewUnsupportedError } from '../src/grew/errors.js';
import { ANCHOR, graphFromSentence } from '../src/grew/rewrite/graph.js';
import { findMatches } from '../src/grew/rewrite/match.js';

// The search compiler and the local rewrite matcher read one Grew pattern in
// two places (compile.js as a query, rewrite/match.js in JS). A rewrite asks
// the server which documents a rule can match, then matches locally, so a
// sentence the matcher matches and the query misses is a sentence a rewrite
// never sees. For every pattern of the shared case list
// (test/fixtures/grewPatterns.json) over a small treebank with a multiword
// token, enhanced edges, a non-projective sentence and sentence metadata,
// every sentence the matcher matches must be one the query finds on a real
// core. A pattern the compiler refuses, or one it marks partialDocs (the
// runner then reads every document), is not compared.

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS = JSON.parse(
  readFileSync(resolve(HERE, '../test/fixtures/grewPatterns.json'), 'utf8'),
);

const CONLLU = [
  '# sent_id = x',
  '# text = the dog saw a cat',
  '1\tthe\tthe\tDET\tDT\tDefinite=Def|PronType=Art\t2\tdet\t2:det\t_',
  '2\tdog\tdog\tNOUN\tNN\tNumber=Sing\t3\tnsubj\t3:nsubj\t_',
  '3\tsaw\tsee\tVERB\tVBD\tTense=Past|VerbForm=Fin\t0\troot\t0:root\t_',
  '4\ta\ta\tDET\tDT\tDefinite=Ind|PronType=Art\t5\tdet\t5:det\t_',
  '5\tcat\tcat\tNOUN\tNN\tNumber=Sing\t3\tobj\t3:obj\t_',
  '',
  // A multiword token over its two syntactic words.
  '# sent_id = s2',
  '# text = du pain est mangé',
  '1-2\tdu\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t3:case\t_',
  '2\tle\tle\tDET\t_\tDefinite=Def|Number=Sing\t3\tdet\t3:det\t_',
  '3\tpain\tpain\tNOUN\t_\tGender=Masc|Number=Sing\t5\tnsubj:pass\t5:nsubj:pass\t_',
  '4\test\têtre\tAUX\t_\tMood=Ind|Number=Sing|Person=3|Tense=Pres\t5\taux:pass\t5:aux:pass\t_',
  '5\tmangé\tmanger\tVERB\t_\tVoice=Pass\t0\troot\t0:root\t_',
  '',
  // The enhanced graph shares the subject and relabels the conjunct.
  '# sent_id = s3',
  '# text = she sang and danced',
  '1\tshe\tshe\tPRON\tPRP\tCase=Nom|Number=Sing|Person=3\t2\tnsubj\t2:nsubj|4:nsubj\t_',
  '2\tsang\tsing\tVERB\tVBD\tTense=Past\t0\troot\t0:root\t_',
  '3\tand\tand\tCCONJ\tCC\t_\t4\tcc\t4:cc\t_',
  '4\tdanced\tdance\tVERB\tVBD\tTense=Past\t2\tconj\t2:conj:and\t_',
  '',
  // Not projective: "hearing ... on" crosses "is scheduled".
  '# sent_id = s4',
  '# text = a hearing is scheduled on the issue today',
  '1\ta\ta\tDET\tDT\tDefinite=Ind\t2\tdet\t_\t_',
  '2\thearing\thearing\tNOUN\tNN\tNumber=Sing\t4\tnsubj:pass\t_\t_',
  '3\tis\tbe\tAUX\tVBZ\tNumber=Sing|Person=3\t4\taux:pass\t_\t_',
  '4\tscheduled\tschedule\tVERB\tVBN\tVoice=Pass\t0\troot\t_\t_',
  '5\ton\ton\tADP\tIN\t_\t7\tcase\t_\t_',
  '6\tthe\tthe\tDET\tDT\tDefinite=Def\t7\tdet\t_\t_',
  '7\tissue\tissue\tNOUN\tNN\tNumber=Sing\t2\tnmod\t_\t_',
  '8\ttoday\ttoday\tNOUN\tNN\tNumber=Sing\t4\tobl:tmod\t_\t_',
  '',
  // A word with no head and no lemma, and the same lemma twice.
  '# sent_id = s5',
  '# text = be quick be bold now',
  '1\tbe\tbe\tAUX\tVB\tMood=Imp\t2\tcop\t_\t_',
  '2\tquick\tquick\tADJ\tJJ\tDegree=Pos\t0\troot\t_\t_',
  '3\tbe\tbe\tAUX\tVB\tMood=Imp\t4\tcop\t_\t_',
  '4\tbold\tbold\tADJ\tJJ\tDegree=Pos\t2\tparataxis\t_\t_',
  '5\tnow\t_\tADV\t_\t_\t_\t_\t_\t_',
].join('\n');

const S = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const { token } = readToken();
  const client = new PlaidClient(CORE, token);
  S.client = client;
  const project = await createUdProject(client, `Grew agreement e2e ${Date.now()}`);
  S.projectId = project.id;
  const res = await ConlluDocument.importFromConllu(client, project.id, 'agree-doc', CONLLU);
  S.doc = await ConlluDocument.load(client, project.id, res.documentId, { project });
  S.limits = await client.server.limits();
});

test.afterAll(async () => {
  try {
    await S.client.projects.delete(S.projectId);
  } catch {
    /* best-effort */
  }
});

// The sentences the query finds, by sentence token id.
async function searched(compiled) {
  if (compiled.impossible) return new Set();
  const r = await S.client.query({
    where: compiled.query.where,
    return: { group: ['?S'], aggregates: [['count']] },
    scope: { projectIds: [S.projectId] },
  });
  return new Set((r?.results || []).map(([id]) => String(id)));
}

// The sentences the rewrite matcher matches, by sentence token id. A match
// whose every node is the root anchor (graph.js: `X [!lemma]` matches it, as
// in Grew) is no sentence a rewrite can write to, since what a rule sets on
// the anchor stays local, so it is not counted.
const onAWord = (m) => m.nodes.size === 0 || [...m.nodes.values()].some((id) => id !== ANCHOR);

function matched(ast) {
  return new Set(
    S.doc.sentences
      .filter((row) => findMatches(ast, graphFromSentence(row)).some(onAWord))
      .map((row) => String(row.id)),
  );
}

// An import keeps a word with no head ("now" here), so the UD tree invariant
// cannot answer `is_tree` or `is_not_tree`: the parser refuses both, and they
// are not compared.
const TREE_FLAG_PATTERNS = PATTERNS.filter((p) => /\bis_(not_)?tree\b/.test(p));

test('a pattern with is_tree or is_not_tree is refused', () => {
  expect(TREE_FLAG_PATTERNS.length).toBeGreaterThan(4);
  for (const pattern of TREE_FLAG_PATTERNS) {
    expect(() => parse(pattern), pattern).toThrow(GrewUnsupportedError);
  }
});

test('every sentence a rule matches locally is one the search finds', async () => {
  test.setTimeout(10 * 60 * 1000);
  expect(S.doc.sentences).toHaveLength(5);
  const missed = [];
  const counts = { compared: 0, refused: 0, partial: 0, unparsed: 0, matched: 0 };
  for (const pattern of PATTERNS) {
    let ast;
    try {
      ast = parse(pattern);
    } catch {
      counts.unparsed += 1;
      continue;
    }
    let compiled;
    try {
      compiled = compileGrew(ast, S.doc.layerInfo, { projectId: S.projectId, limits: S.limits });
    } catch (e) {
      if (!(e instanceof GrewUnsupportedError)) throw e;
      counts.refused += 1;
      continue;
    }
    if (compiled.partialDocs) {
      counts.partial += 1;
      continue;
    }
    const local = matched(ast);
    const server = await searched(compiled);
    counts.compared += 1;
    if (local.size) counts.matched += 1;
    const lost = [...local].filter((id) => !server.has(id));
    if (lost.length) {
      const names = lost.map((id) => S.doc.sentences.find((r) => String(r.id) === id)?.text);
      missed.push(`${pattern}: the search misses ${names.join(' | ')}`);
    }
  }
  console.log(`grew agreement: ${JSON.stringify(counts)}`);
  // The treebank must exercise the list: most patterns are compared, and
  // many match a sentence here.
  expect(counts.compared).toBeGreaterThan(200);
  expect(counts.matched).toBeGreaterThan(100);
  expect(missed).toEqual([]);
});
