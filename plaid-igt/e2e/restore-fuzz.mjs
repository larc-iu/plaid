// Fuzz the restore: edit a throwaway document at random, remember a moment
// T in the middle, keep editing, restore to T, and compare the result with
// the server's own as-of read of T, id-free. Disposable, like the rest of
// e2e/ (see e2e/bugbash/harness.mjs for the fixture project).
//
//   node e2e/restore-fuzz.mjs [seed] [rounds]

import {
  makeClient,
  getFixtureProjectId,
  freshDoc,
  reloadFresh,
  cleanupDoc,
  makeRng,
  pick,
  randInt,
  cpLength,
} from './bugbash/harness.mjs';
import { runAllInvariants } from './bugbash/invariants.mjs';
import { indexDocument, normalizeState, compareStates } from '../src/restore/restorePlan.js';
import { runRestore } from '../src/restore/restoreRunner.js';

const SEED = process.argv[2] ? Number(process.argv[2]) : Date.now() & 0xffffffff;
const ROUNDS = process.argv[3] ? Number(process.argv[3]) : 4;
const rng = makeRng(SEED);
const client = makeClient();
const failures = [];
const log = (...a) => console.log(...a);

const WORDS = [
  'todos',
  'los',
  'seres',
  'humanos',
  'nacen',
  'libres',
  'e',
  'iguales',
  'en',
  'dignidad',
];
const VALUES = ['NOUN', 'VERB', 'ADJ', 'DET', 'ADP'];

const read = async (id, asOf) => indexDocument(await client.documents.get(id, true, asOf));

// Word boundaries of the body: [begin, end) of every space-separated run.
function wordRuns(body) {
  const runs = [];
  let i = 0;
  for (const w of body.split(' ')) {
    if (w.length) runs.push([i, i + cpLength(w)]);
    i += cpLength(w) + 1;
  }
  return runs;
}

// ---- random edits, each against a fresh read -------------------------------
// Every edit is one of the things a person (or another app) does to a
// document; a rejected one is skipped and counted, never a failure.
const EDITS = {
  async insertWord(idx) {
    const runs = wordRuns(idx.text.body);
    const at = pick(rng, runs)[1];
    const body = idx.text.body.slice(0, at) + ' ' + pick(rng, WORDS) + idx.text.body.slice(at);
    await client.texts.update(idx.text.id, body);
  },
  async deleteWordText(idx) {
    const runs = wordRuns(idx.text.body);
    if (runs.length < 3) return;
    const [b, e] = pick(rng, runs);
    const body = (idx.text.body.slice(0, b) + idx.text.body.slice(e)).replace(/  +/g, ' ');
    await client.texts.update(idx.text.id, body);
  },
  async respell(idx) {
    const words = [...idx.layers.word.tokens.values()];
    if (!words.length) return;
    const w = pick(rng, words);
    const cps = [...idx.text.body];
    cps.splice(w.begin, w.end - w.begin, ...pick(rng, WORDS).toUpperCase());
    await client.texts.update(idx.text.id, cps.join(''));
  },
  async splitSentence(idx) {
    const sents = [...idx.layers.sentence.tokens.values()].sort((a, b) => a.begin - b.begin);
    const s = pick(rng, sents);
    const inside = wordRuns(idx.text.body)
      .map((r) => r[0])
      .filter((p) => p > s.begin && p < s.end);
    if (!inside.length) return;
    await client.tokens.split(s.id, pick(rng, inside));
  },
  async mergeSentences(idx) {
    const sents = [...idx.layers.sentence.tokens.values()].sort((a, b) => a.begin - b.begin);
    if (sents.length < 2) return;
    const i = randInt(rng, 0, sents.length - 2);
    await client.tokens.merge(sents[i].id, sents[i + 1].id);
  },
  async shiftSentence(idx) {
    const sents = [...idx.layers.sentence.tokens.values()].sort((a, b) => a.begin - b.begin);
    if (sents.length < 2) return;
    const i = randInt(rng, 0, sents.length - 2);
    const left = sents[i];
    const right = sents[i + 1];
    const spots = wordRuns(idx.text.body)
      .map((r) => r[0])
      .filter((p) => p > left.begin && p < right.end && p !== left.end);
    if (!spots.length) return;
    await client.tokens.shift(left.id, undefined, pick(rng, spots));
  },
  async deleteWord(idx) {
    const words = [...idx.layers.word.tokens.values()];
    if (words.length < 2) return;
    await client.tokens.bulkDelete([pick(rng, words).id]);
  },
  async recreateWords(idx) {
    // Words the tokenizer would make, where none stand.
    const have = [...idx.layers.word.tokens.values()];
    const missing = wordRuns(idx.text.body).filter(
      ([b, e]) => !have.some((w) => w.begin < e && b < w.end),
    );
    if (!missing.length) return;
    const specs = missing.slice(0, randInt(rng, 1, missing.length)).map(([begin, end]) => ({
      tokenLayerId: idx.layers.word.id,
      text: idx.text.id,
      begin,
      end,
    }));
    await client.tokens.bulkCreate(specs);
  },
  async shrinkWord(idx) {
    const words = [...idx.layers.word.tokens.values()].filter((w) => w.end - w.begin > 2);
    if (!words.length) return;
    const w = pick(rng, words);
    await client.tokens.update(w.id, undefined, w.end - 1);
  },
  async morphemes(idx) {
    const words = [...idx.layers.word.tokens.values()].filter((w) => w.end - w.begin > 1);
    if (!words.length || !idx.layers.morpheme) return;
    const w = pick(rng, words);
    const mine = [...idx.layers.morpheme.tokens.values()].filter(
      (m) => m.begin === w.begin && m.end === w.end,
    );
    if (mine.length) {
      await client.tokens.bulkDelete(mine.map((m) => m.id));
      return;
    }
    const text = idx.text.body.slice(w.begin, w.end);
    const cut = randInt(rng, 1, text.length - 1);
    await client.tokens.bulkCreate(
      [text.slice(0, cut), text.slice(cut)].map((form, i) => ({
        tokenLayerId: idx.layers.morpheme.id,
        text: idx.text.id,
        begin: w.begin,
        end: w.end,
        precedence: i + 1,
        metadata: { form },
      })),
    );
  },
  async tokenMetadata(idx) {
    const words = [...idx.layers.word.tokens.values()];
    if (!words.length) return;
    const w = pick(rng, words);
    if (Object.keys(w.metadata).length && rng() < 0.5) await client.tokens.deleteMetadata(w.id);
    else await client.tokens.setMetadata(w.id, { 'orthog:Translit': pick(rng, WORDS) });
  },
  async span(idx) {
    const layer = pick(rng, ['sentence', 'word', 'morpheme']);
    const L = idx.layers[layer];
    const sl = L?.spanLayers?.[0];
    const toks = [...(L?.tokens.values() || [])];
    if (!sl || !toks.length) return;
    const existing = [...sl.spans.values()];
    const roll = rng();
    if (existing.length && roll < 0.3) {
      await client.spans.bulkDelete([pick(rng, existing).id]);
    } else if (existing.length && roll < 0.6) {
      await client.spans.update(pick(rng, existing).id, pick(rng, VALUES));
    } else {
      const t = pick(rng, toks);
      if (existing.some((s) => s.tokens.length === 1 && s.tokens[0] === t.id)) return;
      await client.spans.bulkCreate([
        { spanLayerId: sl.id, tokens: [t.id], value: pick(rng, VALUES) },
      ]);
    }
  },
  async link(idx, ctx) {
    const words = [...idx.layers.word.tokens.values()];
    if (!words.length || !ctx.itemIds.length) return;
    const existing = [...idx.links.values()];
    if (existing.length && rng() < 0.4) {
      await client.vocabLinks.bulkDelete([pick(rng, existing).id]);
      return;
    }
    const w = pick(rng, words);
    if (existing.some((l) => l.tokens.includes(w.id))) return;
    await client.vocabLinks.create(pick(rng, ctx.itemIds), [w.id], { prov: 'fuzz' });
  },
  async docMetadata(idx) {
    if (Object.keys(idx.metadata).length && rng() < 0.5) {
      await client.documents.deleteMetadata(idx.id);
    } else await client.documents.setMetadata(idx.id, { note: pick(rng, WORDS) });
  },
};

async function edit(documentId, ctx, n) {
  let done = 0;
  let rejected = 0;
  const names = Object.keys(EDITS);
  for (let i = 0; i < n; i++) {
    const name = pick(rng, names);
    const idx = await read(documentId);
    try {
      await EDITS[name](idx, ctx);
      done += 1;
    } catch (err) {
      rejected += 1;
      ctx.rejections.push(`${name}: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  return { done, rejected };
}

async function lastOperationTime(documentId) {
  const entries = await client.documents.audit(documentId);
  const last = entries[entries.length - 1];
  return last?.endTime || last?.time;
}

async function round(projectId, ctx, n) {
  const body = Array.from({ length: randInt(rng, 6, 12) }, () => pick(rng, WORDS)).join(' ');
  const { documentId } = await freshDoc(client, projectId, { body });
  const result = { documentId, failures: [] };
  try {
    const a = await edit(documentId, ctx, randInt(rng, 4, 10));
    const T = await lastOperationTime(documentId);
    // The as-of read at T must equal the live read now, or the target the
    // restore aims at is not what was on screen.
    const live = normalizeState(await read(documentId));
    const target = normalizeState(await read(documentId, T));
    const sanity = compareStates(live, target);
    if (sanity.length)
      result.failures.push(`as-of read differs from live at T: ${sanity.join('; ')}`);
    const b = await edit(documentId, ctx, randInt(rng, 4, 10));
    const res = await runRestore({ client, documentId, asOf: T });
    const after = normalizeState(await read(documentId));
    const diffs = compareStates(after, target);
    if (diffs.length) result.failures.push(`restored state differs: ${diffs.join('; ')}`);
    if (!res.exact) result.failures.push(`self-check reported: ${res.differences.join('; ')}`);
    if (res.warnings.length) result.failures.push(`warnings: ${res.warnings.join('; ')}`);
    const again = await runRestore({ client, documentId, asOf: T });
    if (again.summary.total !== 0)
      result.failures.push(`second restore still planned ${again.summary.total} changes`);
    const inv = runAllInvariants(await reloadFresh(client, projectId, documentId));
    if (!inv.ok) {
      result.failures.push(
        `invariants: ${inv.violations.map((v) => `${v.name}: ${v.msg}`).join('; ')}`,
      );
    }
    log(
      `  round ${n}: ${a.done + b.done} edits (${a.rejected + b.rejected} rejected), restore planned ${res.summary.total}, ${result.failures.length ? 'FAIL' : 'ok'}`,
    );
  } catch (err) {
    result.failures.push(`threw: ${err?.message ?? err}`);
    log(`  round ${n}: threw ${err?.message ?? err}`);
  } finally {
    await cleanupDoc(client, documentId);
  }
  return result;
}

const projectId = await getFixtureProjectId(client);
const project = await client.projects.get(projectId);
const vocabId = project.vocabs?.[0]?.id ?? null;
let itemIds = [];
if (vocabId) {
  const v = await client.vocabLayers.get(vocabId, true);
  itemIds = (v.items || []).slice(0, 5).map((it) => it.id);
  if (!itemIds.length) {
    const it = await client.vocabItems.create(vocabId, 'fuzz');
    itemIds = [it.id];
  }
}
const ctx = { itemIds, rejections: [] };
log(`restore fuzz: seed ${SEED}, ${ROUNDS} rounds, ${itemIds.length} vocab items`);
for (let i = 1; i <= ROUNDS; i++) {
  const r = await round(projectId, ctx, i);
  if (r.failures.length) failures.push({ round: i, ...r });
}
if (ctx.rejections.length) {
  const tally = {};
  for (const r of ctx.rejections) tally[r.split(':')[0]] = (tally[r.split(':')[0]] || 0) + 1;
  log('rejected edits by kind:', JSON.stringify(tally));
}
if (failures.length) {
  console.error(`\n${failures.length} failing round(s) (seed ${SEED}):`);
  for (const f of failures) console.error(`  round ${f.round}:\n    ${f.failures.join('\n    ')}`);
  process.exit(1);
}
log(`all ${ROUNDS} rounds restored exactly (seed ${SEED})`);
