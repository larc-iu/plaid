// Shared foundation for the plaid-igt data-integrity bug bash.
//
// The big idea: the integrity-critical logic (alignment ordering, the server
// text-edit cascade, partition re-seeding, code-point offsets) lives in the
// FRAMEWORK-AGNOSTIC domain layer (src/domain/IgtDocument.js + mutations/*).
// So we construct a real IgtDocument against the LIVE plaid-core (:8085),
// swapping in a real PlaidClient, and drive the exact same mutation methods the
// React UI calls — then reload a fresh copy from the server and assert
// invariants. No browser needed for the fuzzing bulk.
//
// Each fuzz run creates its OWN throwaway document inside the shared E2E
// fixture PROJECT (reusing the layer hierarchy) so parallel agents don't stomp
// each other. Clean up with cleanupDoc() when done.
//
// Node 18: `File` is not global — import it from node:buffer.

import PlaidClient, { cpLength } from '@larc-iu/plaid-client';
import { IgtDocument } from '../../src/domain/IgtDocument.js';
import { readToken } from '../fixtures.js';
import { File } from 'node:buffer';

export const CORE_URL = process.env.PLAID_CORE_URL || 'http://localhost:8085';
export const FIXTURE_PROJECT_NAME = 'E2E IGT Fixture';

export function makeClient() {
  const { token } = readToken();
  return new PlaidClient(CORE_URL, token);
}

// ---- seeded RNG (mulberry32) — reproducible fuzzing ---------------------
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---- layer resolution (mirrors fixture.js resolveLayers + alignment) ----
export function resolveLayers(project) {
  const tl = (project.textLayers || []).find((l) => l.config?.plaid?.primary) || (project.textLayers || [])[0];
  const tks = tl?.tokenLayers || [];
  return {
    textLayerId: tl?.id,
    sentenceLayerId: tks.find((l) => l.config?.plaid?.sentence)?.id,
    wordLayerId: tks.find((l) => l.config?.plaid?.primary)?.id,
    morphemeLayerId: tks.find((l) => l.config?.plaid?.morpheme)?.id,
    alignmentLayerId: tks.find((l) => l.config?.plaid?.alignment)?.id,
  };
}

export async function getFixtureProjectId(client) {
  const projects = await client.projects.list();
  const p = projects.find((x) => x.name === FIXTURE_PROJECT_NAME);
  if (!p) throw new Error(`Fixture project "${FIXTURE_PROJECT_NAME}" not found — run: node e2e/fixture.js`);
  return p.id;
}

// ---- code-point-aware whitespace tokenizer ------------------------------
// Offsets are CODE POINTS (not UTF-16), so astral bodies tokenize correctly.
export function cpTokenize(body) {
  const cps = Array.from(body); // iterates by code point
  const toks = [];
  let i = 0;
  while (i < cps.length) {
    while (i < cps.length && /\s/.test(cps[i])) i++;
    if (i >= cps.length) break;
    const begin = i;
    while (i < cps.length && !/\s/.test(cps[i])) i++;
    toks.push({ begin, end: i });
  }
  return toks;
}

let docCounter = 0;

// Create a NEW throwaway document in the fixture project, seed it with a
// sentence partition over the whole body + word tokens + (optional) morphemes,
// and return a loaded IgtDocument. Returns { doc, documentId }.
export async function freshDoc(client, projectId, opts = {}) {
  const {
    body = ' Todos los seres humanos nacen libres e iguales en dignidad y derechos.',
    seedWords = true,
    seedMorphemes = true,
    name = `BugBash ${Date.now()}-${++docCounter}`,
  } = opts;

  const project = await client.projects.get(projectId);
  const L = resolveLayers(project);
  if (!L.textLayerId) throw new Error('No primary text layer in fixture project');

  const created = await client.documents.create(projectId, name);
  const docId = created.id;
  await client.texts.create(L.textLayerId, docId, body);

  // Re-fetch to get the text id, then seed tokens in code-point offsets.
  const raw = await client.documents.get(docId, true);
  const tl = (raw.textLayers || []).find((l) => l.config?.plaid?.primary);
  const textId = tl?.text?.id;
  const len = cpLength(body);

  if (textId && len > 0) {
    if (L.sentenceLayerId) {
      await client.tokens.bulkCreate([{ tokenLayerId: L.sentenceLayerId, text: textId, begin: 0, end: len }]);
    }
    const words = cpTokenize(body);
    if (seedWords && L.wordLayerId && words.length) {
      await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: L.wordLayerId, text: textId, begin: w.begin, end: w.end })));
    }
    if (seedMorphemes && L.morphemeLayerId && words.length) {
      await client.tokens.bulkCreate(words.map((w) => ({ tokenLayerId: L.morphemeLayerId, text: textId, begin: w.begin, end: w.end, precedence: 1 })));
    }
  }

  const doc = await IgtDocument.load(client, projectId, docId);
  return { doc, documentId: docId };
}

// Load a brand-new IgtDocument instance from the server — "ground truth" for
// comparing against an optimistically-patched doc.
export async function reloadFresh(client, projectId, documentId) {
  return IgtDocument.load(client, projectId, documentId);
}

export async function cleanupDoc(client, documentId) {
  try { await client.documents.delete(documentId); } catch { /* best effort */ }
}

// ---- minimal valid WAV (16-bit PCM, 8kHz mono, silence) -----------------
// Tika validates uploaded media content, so a random blob is rejected; this is
// a real RIFF/WAVE file Tika recognizes as audio.
export function wavBytes(seconds = 0.25) {
  const sampleRate = 8000, numCh = 1, bits = 16;
  const numSamples = Math.max(1, Math.floor(sampleRate * seconds));
  const blockAlign = numCh * (bits / 8);
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // 16-bit silence is all-zero; buffer already zeroed.
  return buf;
}

export function tinyWav(seconds = 0.25, name = 'bugbash.wav') {
  return new File([wavBytes(seconds)], name, { type: 'audio/wav' });
}

export { cpLength };
