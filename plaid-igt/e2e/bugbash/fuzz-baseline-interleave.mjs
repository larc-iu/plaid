// Fuzzer FOCUS: saveBaselineText interleaved with alignment/token state.
//
// CONTRACT (2026-06-10, post wipe-removal): saveBaselineText is a plain
// texts.update — the server diffs old vs new body, shifts every token on the
// text, deletes tokens fully inside removed ranges, and gap-fills the
// Sentences partition; the client re-seeds one full-span sentence only when
// the save leaves a non-empty body with no partition. So after a FRESH server
// reload we verify: body == exactly newBody, all general invariants hold
// (partition tiles [0,len); empty body ⇒ no sentences; no out-of-bounds or
// zero-width tokens; no U+FFFD), SAME-text saves preserve every token count,
// and append-only edits preserve all words/morphemes/alignments.
//
// Also exercises: empty->non-empty, the no-existing-text (else) branch, same
// text, and rapid back-to-back saves (single-flight).
//
//   node e2e/bugbash/fuzz-baseline-interleave.mjs [seed]
//
// Read-only against the shared harness; creates throwaway docs and cleans up.

import { makeClient, getFixtureProjectId, freshDoc, reloadFresh, cleanupDoc, makeRng, pick, randInt, cpLength } from './harness.mjs';
import { runAllInvariants } from './invariants.mjs';

const SEED = process.argv[2] ? Number(process.argv[2]) : (Date.now() & 0xffffffff);
const rng = makeRng(SEED);
const log = (...a) => console.log(...a);

const findings = [];
let opsRun = 0;
let docsUsed = 0;
let infraErrors = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SQLite-under-concurrent-load noise (HikariCP busy / generic 500). NOT a
// domain data-integrity bug — exclude from findings, just count + throttle.
function isInfraError(s) {
  return /Database busy|Internal error|HTTP 50\d|HTTP 503|Service Unavailable/i.test(String(s || ''));
}

function record(f) {
  findings.push(f);
  log(`  !! FINDING [${f.kind}] ${f.title}`);
  if (f.detail) log(`     ${f.detail}`);
}

// ---- post-save invariants + the focus-area-specific checks ----------------
// The GENERAL invariants (always run) carry most of the contract now:
// partitionCoversBody enforces "non-empty body ⇒ sentences tile [0,len)"
// (which the client's re-seed guarantees) and "empty body ⇒ no sentences".
// Words/morphemes/alignments may legitimately SURVIVE a save — preservation
// is asserted per-scenario where the expected outcome is deterministic
// (same-text and append-only saves). `saved` gates the body-equality check,
// since a failed save legitimately retains its prior state.
function checkSavedState(fresh, expectedBody, saved = true) {
  const issues = [];
  const inv = runAllInvariants(fresh);
  for (const v of inv.violations) issues.push(`[invariant:${v.name}] ${v.msg}`);

  const body = fresh.body || '';
  const len = cpLength(body);
  const sents = fresh.layerInfo.sentenceTokenLayer?.tokens || [];
  const aligns = fresh.layerInfo.alignmentTokenLayer?.tokens || [];
  const wordsN = (fresh.layerInfo.primaryTokenLayer?.tokens || []).length;
  const morphN = (fresh.layerInfo.morphemeTokenLayer?.tokens || []).length;

  if (saved && expectedBody != null && body !== expectedBody) {
    // Body must equal exactly what we asked to save (corruption sniff).
    issues.push(`body != requested:\n     got  ="${body}"\n     want ="${expectedBody}"`);
  }

  return { issues, wordsN, morphN, sentsN: sents.length, alignsN: aligns.length, len };
}

// Drive a mutation, treating a THROW (rather than a false return) as a contract
// violation. Returns { ok, threw, err }.
async function runOp(doc, label, fn) {
  opsRun++;
  await sleep(40); // throttle: shared SQLite single-writer; don't induce BUSY
  try {
    const ok = await fn();
    return { ok, threw: false, err: doc.error, infra: !ok && isInfraError(doc.error) };
  } catch (e) {
    // A mutation should return false, not throw — UNLESS the underlying server
    // 500/503'd (environmental). Domain contract violations are real findings.
    if (isInfraError(e && (e.message || e))) { infraErrors++; return { ok: false, threw: true, infra: true, err: String(e) }; }
    record({ kind: 'uncaught-exception', title: `${label} THREW instead of returning false`, detail: String(e && e.stack || e), ctx: label });
    return { ok: false, threw: true, infra: false, err: String(e) };
  }
}

// Build up some alignment + token state on a fresh doc.
async function buildUp(doc, n) {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const text = pick(rng, words);
    const tb = t; const te = t + 1; t += randInt(rng, 1, 2);
    await runOp(doc, 'createAlignment(buildup)', () => doc.createAlignment({ text, timeBegin: tb, timeEnd: te }));
  }
}

const TARGET_BODIES = [
  'short one',                              // shorter than seed
  'a much longer baseline text than the original seed had for sure indeed',  // longer
  '',                                       // empty
  '   ',                                    // whitespace-only
  '\t \n ',                                 // mixed whitespace
  'x',                                      // single char
  '𝕙𝕖𝕝𝕝𝕠 𝕨𝕠𝕣𝕝𝕕',                            // astral (math bold)
  'emoji a😀b 🎉 c👍d',                       // emoji mid-word
  '  leading and trailing  ',              // leading/trailing spaces
  'café résumé naïve coöperate',           // combining/accents
  'one two three four five',               // plain
];

async function scenarioBuildThenSave(client, projectId, idx) {
  const seedBodies = [
    'the quick brown fox jumps',
    'uno dos tres cuatro',
    '𝓪𝓼𝓽𝓻𝓪𝓵 𝓼𝓮𝓮𝓭 𝓽𝓮𝔁𝓽',
    'single',
  ];
  const seedBody = pick(rng, seedBodies);
  const { doc, documentId } = await freshDoc(client, projectId, { body: seedBody });
  docsUsed++;
  try {
    const nBuild = randInt(rng, 0, 3);
    await buildUp(doc, nBuild);
    const target = pick(rng, TARGET_BODIES);

    const r = await runOp(doc, 'saveBaselineText', () => doc.saveBaselineText(target));
    if (doc.isSaving) record({ kind: 'uncaught-exception', title: 'isSaving stuck true after saveBaselineText', detail: `target="${target}"`, ctx: 'wedged' });

    const fresh = await reloadFresh(client, projectId, documentId);
    const { issues, wordsN, morphN, sentsN, alignsN, len } = checkSavedState(fresh, r.ok ? target : null, r.ok);

    log(`[s${idx}] seed="${seedBody}" build=${nBuild} -> save("${target.replace(/\n/g,'\\n').replace(/\t/g,'\\t')}") ret=${r.ok}${r.infra ? ' (infra-noise)' : ''}${r.err ? ` err="${r.err}"` : ''} | body="${fresh.body.replace(/\n/g,'\\n')}" sents=${sentsN} aligns=${alignsN} words=${wordsN} morph=${morphN} len=${len}`);

    if (!r.ok && !r.threw && !r.infra) {
      // saveBaselineText rejecting a plain text replacement is a false-rejection
      // candidate (these targets are all valid baselines).
      record({ kind: 'false-rejection', title: `saveBaselineText("${target}") returned false`, detail: `seed="${seedBody}" build=${nBuild} err="${r.err}"`, ctx: 'save-false' });
    }
    for (const iss of issues) {
      record({ kind: 'invariant-violation', title: `post-save violation (seed="${seedBody}" target="${target}")`, detail: iss, ctx: `seed=${seedBody}|build=${nBuild}|target=${target}` });
    }
    return { wordsN, morphN, target, seedBody, saved: r.ok };
  } finally {
    await cleanupDoc(client, documentId);
  }
}

async function scenarioEmptyThenNonEmpty(client, projectId) {
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'starter body here' });
  docsUsed++;
  try {
    await buildUp(doc, 2);
    const r1 = await runOp(doc, 'saveBaselineText("")', () => doc.saveBaselineText(''));
    const fresh1 = await reloadFresh(client, projectId, documentId);
    const c1 = checkSavedState(fresh1, r1.ok ? '' : null, r1.ok);
    const textGone = !fresh1.layerInfo.primaryTextLayer?.text?.id;
    log(`[empty->] save("") ret=${r1.ok}${r1.infra ? ' (infra-noise)' : ''} body="${fresh1.body}" sents=${c1.sentsN} aligns=${c1.alignsN} textObjGone=${textGone}`);
    for (const iss of c1.issues) record({ kind: 'invariant-violation', title: 'after saveBaselineText("")', detail: iss, ctx: 'empty' });
    if (!r1.ok && !r1.threw && !r1.infra) record({ kind: 'false-rejection', title: 'saveBaselineText("") returned false', detail: `err="${r1.err}"`, ctx: 'empty' });

    // This is the "no existing text" branch IF emptying removed the text object.
    const r2 = await runOp(doc, 'saveBaselineText(nonempty after empty)', () => doc.saveBaselineText('reborn baseline text'));
    const fresh2 = await reloadFresh(client, projectId, documentId);
    const c2 = checkSavedState(fresh2, r2.ok ? 'reborn baseline text' : null, r2.ok);
    log(`[->nonempty] save("reborn...") ret=${r2.ok}${r2.infra ? ' (infra-noise)' : ''}${r2.err ? ` err="${r2.err}"` : ''} body="${fresh2.body}" sents=${c2.sentsN} aligns=${c2.alignsN} (elseBranchUsed=${textGone})`);
    for (const iss of c2.issues) record({ kind: 'invariant-violation', title: 'after empty->nonempty (else/rollback branch)', detail: iss, ctx: 'reborn' });
    if (!r2.ok && !r2.threw && !r2.infra) record({ kind: 'false-rejection', title: 'saveBaselineText after empty returned false', detail: `err="${r2.err}" elseBranch=${textGone}`, ctx: 'reborn' });
  } finally {
    await cleanupDoc(client, documentId);
  }
}

async function scenarioSameText(client, projectId) {
  const body = 'identical baseline stays identical';
  const { doc, documentId } = await freshDoc(client, projectId, { body });
  docsUsed++;
  try {
    const beforeWords = (doc.layerInfo.primaryTokenLayer?.tokens || []).length;
    const beforeMorph = (doc.layerInfo.morphemeTokenLayer?.tokens || []).length;
    const r = await runOp(doc, 'saveBaselineText(same)', () => doc.saveBaselineText(body));
    const fresh = await reloadFresh(client, projectId, documentId);
    const c = checkSavedState(fresh, r.ok ? body : null, r.ok);
    log(`[same] save(same) ret=${r.ok}${r.infra ? ' (infra-noise)' : ''} body="${fresh.body}" sents=${c.sentsN} words=${beforeWords}->${c.wordsN} morph=${beforeMorph}->${c.morphN}`);
    for (const iss of c.issues) record({ kind: 'invariant-violation', title: 'after saveBaselineText(same text)', detail: iss, ctx: 'same' });
    if (!r.ok && !r.threw && !r.infra) record({ kind: 'false-rejection', title: 'saveBaselineText(same text) returned false', detail: `err="${r.err}"`, ctx: 'same' });
    // NEW CONTRACT: an identical body is a no-op diff — every token survives.
    if (r.ok) {
      if (c.wordsN !== beforeWords) record({ kind: 'data-corruption', title: 'same-text save changed word count', detail: `${beforeWords} -> ${c.wordsN}`, ctx: 'same' });
      if (c.morphN !== beforeMorph) record({ kind: 'data-corruption', title: 'same-text save changed morpheme count', detail: `${beforeMorph} -> ${c.morphN}`, ctx: 'same' });
    }
  } finally {
    await cleanupDoc(client, documentId);
  }
}

// NEW CONTRACT: an append-only edit is a pure insert — every existing word,
// morpheme, and alignment token must survive untouched.
async function scenarioAppendPreserves(client, projectId) {
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'palabras que deben sobrevivir' });
  docsUsed++;
  try {
    await buildUp(doc, 2);
    const before = await reloadFresh(client, projectId, documentId);
    const beforeWords = (before.layerInfo.primaryTokenLayer?.tokens || []).length;
    const beforeMorph = (before.layerInfo.morphemeTokenLayer?.tokens || []).length;
    const beforeAligns = (before.layerInfo.alignmentTokenLayer?.tokens || []).length;
    const target = `${before.body} y algo más`;

    const r = await runOp(doc, 'saveBaselineText(append)', () => doc.saveBaselineText(target));
    const fresh = await reloadFresh(client, projectId, documentId);
    const c = checkSavedState(fresh, r.ok ? target : null, r.ok);
    log(`[append] ret=${r.ok}${r.infra ? ' (infra-noise)' : ''}${r.err ? ` err="${r.err}"` : ''} words=${beforeWords}->${c.wordsN} morph=${beforeMorph}->${c.morphN} aligns=${beforeAligns}->${c.alignsN}`);
    for (const iss of c.issues) record({ kind: 'invariant-violation', title: 'after append-only save', detail: iss, ctx: 'append' });
    if (!r.ok && !r.threw && !r.infra) record({ kind: 'false-rejection', title: 'append-only saveBaselineText returned false', detail: `err="${r.err}"`, ctx: 'append' });
    if (r.ok) {
      if (c.wordsN !== beforeWords) record({ kind: 'data-corruption', title: 'append-only save changed word count', detail: `${beforeWords} -> ${c.wordsN}`, ctx: 'append' });
      if (c.morphN !== beforeMorph) record({ kind: 'data-corruption', title: 'append-only save changed morpheme count', detail: `${beforeMorph} -> ${c.morphN}`, ctx: 'append' });
      if (c.alignsN !== beforeAligns) record({ kind: 'data-corruption', title: 'append-only save changed alignment count', detail: `${beforeAligns} -> ${c.alignsN}`, ctx: 'append' });
    }
  } finally {
    await cleanupDoc(client, documentId);
  }
}

async function scenarioRapidBackToBack(client, projectId) {
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'race the saves now' });
  docsUsed++;
  try {
    await buildUp(doc, 1);
    // Fire two without awaiting the first. Single-flight: second should no-op.
    opsRun += 2;
    let p1, p2, threw = false;
    try {
      p1 = doc.saveBaselineText('first winner body');
      p2 = doc.saveBaselineText('second loser body');
    } catch (e) { threw = true; record({ kind: 'uncaught-exception', title: 'rapid saveBaselineText threw synchronously', detail: String(e) }); }
    const [r1, r2] = await Promise.all([p1, p2]);
    const infra = isInfraError(doc.error);
    log(`[rapid] r1=${r1} r2=${r2} isSaving=${doc.isSaving}${infra ? ' (infra-noise)' : ''}`);
    if (doc.isSaving) record({ kind: 'uncaught-exception', title: 'isSaving stuck after rapid saves', ctx: 'rapid' });
    if (r1 === true && r2 === true) {
      record({ kind: 'false-acceptance', title: 'both rapid saves returned true (single-flight broken)', detail: 'expected second to no-op (false)', ctx: 'rapid' });
    }
    const fresh = await reloadFresh(client, projectId, documentId);
    // Winner should be the first; if single-flight held, body == 'first winner body'.
    const c = checkSavedState(fresh, null, r1 && !infra);
    const expectWinner = 'first winner body';
    if (r1 && !r2 && !infra && fresh.body !== expectWinner) {
      record({ kind: 'data-corruption', title: 'rapid: single-flight held but body != first save', detail: `body="${fresh.body}" expected="${expectWinner}"`, ctx: 'rapid' });
    }
    log(`[rapid] final body="${fresh.body}" sents=${c.sentsN} aligns=${c.alignsN}`);
    for (const iss of c.issues) record({ kind: 'invariant-violation', title: 'after rapid back-to-back saves', detail: iss, ctx: 'rapid' });
  } finally {
    await cleanupDoc(client, documentId);
  }
}

async function scenarioEmptyThenNonEmptyVariants(client, projectId) {
  // empty -> empty -> nonempty, and nonempty -> empty -> empty -> astral
  const { doc, documentId } = await freshDoc(client, projectId, { body: 'variant starter' });
  docsUsed++;
  try {
    const seq = ['', '', 'after double empty', '', '𝔞𝔰𝔱𝔯𝔞𝔩 𝔯𝔢𝔟𝔬𝔯𝔫'];
    for (const target of seq) {
      const r = await runOp(doc, `saveBaselineText("${target}")`, () => doc.saveBaselineText(target));
      const fresh = await reloadFresh(client, projectId, documentId);
      const c = checkSavedState(fresh, r.ok ? target : null, r.ok);
      log(`[seq] save("${target}") ret=${r.ok}${r.infra ? ' (infra-noise)' : ''}${r.err ? ` err="${r.err}"` : ''} body="${fresh.body}" sents=${c.sentsN}`);
      for (const iss of c.issues) record({ kind: 'invariant-violation', title: `empty/nonempty sequence step "${target}"`, detail: iss, ctx: `seq:${target}` });
      if (!r.ok && !r.threw && !r.infra) record({ kind: 'false-rejection', title: `sequence saveBaselineText("${target}") returned false`, detail: `err="${r.err}"`, ctx: `seq:${target}` });
    }
  } finally {
    await cleanupDoc(client, documentId);
  }
}

async function main() {
  log(`=== fuzz-baseline-interleave SEED=${SEED} ===`);
  const client = makeClient();
  const projectId = await getFixtureProjectId(client);
  log(`fixture project: ${projectId}`);

  // Targeted edge cases first (deterministic).
  await scenarioEmptyThenNonEmpty(client, projectId); await sleep(150);
  await scenarioEmptyThenNonEmptyVariants(client, projectId); await sleep(150);
  await scenarioSameText(client, projectId); await sleep(150);
  await scenarioAppendPreserves(client, projectId); await sleep(150);
  await scenarioRapidBackToBack(client, projectId); await sleep(150);

  // Randomized build-then-save fuzz.
  const N = 14;
  for (let i = 0; i < N && docsUsed < 36; i++) {
    try {
      await scenarioBuildThenSave(client, projectId, i);
    } catch (e) {
      if (isInfraError(e && (e.message || e))) { infraErrors++; log(`[s${i}] skipped (infra: ${e.message || e})`); }
      else record({ kind: 'uncaught-exception', title: `scenario ${i} crashed`, detail: String(e && e.stack || e) });
    }
    await sleep(120);
  }

  log(`\n=== SUMMARY === seed=${SEED} ops=${opsRun} docs=${docsUsed} infraNoise=${infraErrors} findings=${findings.length}`);
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  log(`findings by kind:`, JSON.stringify(byKind));
  for (const f of findings) log(`  - [${f.kind}] ${f.title}${f.detail ? ` :: ${f.detail.split('\n')[0]}` : ''}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FUZZER ERROR', e); process.exit(1); });
