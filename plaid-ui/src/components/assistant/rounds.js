import { useMemo } from 'react';

// What the assistant was sent back and wrote, one model call (a "round") at a
// time, stored by the service beside the conversation
// (plaid_agent/core/rounds.py): the question as the model received it, the
// text it wrote beside its tool calls, each call's arguments and the result
// exactly as the model was sent it. A step of a turn names its round, and
// opening the step reads it. Rounds are written once and never change, so a
// round read is kept for the page's life.
//
// The instructions the model was given (system prompt and tool list) are
// stored once per distinct prompt, named by the first round of a turn.

const roundKey = (app, projectId, convId, roundId) =>
  `${app}:assistant:${projectId}:round:${convId}:${roundId}`;

export const roundPrefix = (app, projectId, convId) =>
  `${app}:assistant:${projectId}:round:${convId}:`;

const promptKey = (app, projectId, convId, hash) =>
  `${app}:assistant:${projectId}:prompt:${convId}:${hash}`;

// Values read, by key, for the page's life. A promise while it is read.
const kept = (globalThis.__plaidAssistantRounds ??= new Map());

// A reader of one conversation's rounds and prompts. `read(key)` resolves to
// the stored value, or null when there is none (it was never stored, or went
// with its conversation), and rejects on any other failure. `peek` answers
// from what was read already, which is all an export has.
export const roundReader = (read, { app, projectId, convId }) => {
  const get = (key) => {
    const was = kept.get(key);
    if (was !== undefined) return Promise.resolve(was);
    const p = Promise.resolve(read(key)).then(
      (v) => {
        if (v == null) kept.delete(key);
        else kept.set(key, v);
        return v ?? null;
      },
      (e) => {
        kept.delete(key);
        throw e;
      },
    );
    kept.set(key, p);
    return p;
  };
  const peekKey = (key) => {
    const v = kept.get(key);
    return v && typeof v.then !== 'function' ? v : null;
  };
  return {
    round: (id) => get(roundKey(app, projectId, convId, id)),
    prompt: (hash) => get(promptKey(app, projectId, convId, hash)),
    peek: (id) => peekKey(roundKey(app, projectId, convId, id)),
    peekPrompt: (hash) => peekKey(promptKey(app, projectId, convId, hash)),
  };
};

// A reader over rounds already in hand (the export's), keyed by round id.
export const roundsInHand = (rounds, prompts = new Map()) => ({
  round: (id) => Promise.resolve(rounds.get(id) ?? null),
  prompt: (hash) => Promise.resolve(prompts.get(hash) ?? null),
  peek: (id) => rounds.get(id) ?? null,
  peekPrompt: (hash) => prompts.get(hash) ?? null,
});

// The value under a key of the user's store through the JS client, or null
// for a key that is not there.
const storedValue = (client, userId) => async (key) => {
  try {
    const entry = await client.userData.get(userId, key);
    return entry?.value ?? null;
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
};

// The rounds of the conversation on screen, read with `client` from
// `userId`'s store (the user's own, or the owner's from the admin area).
export const useRounds = (client, userId, app, projectId, convId) =>
  useMemo(
    () =>
      client && userId && convId
        ? roundReader(storedValue(client, userId), { app, projectId, convId })
        : null,
    [client, userId, app, projectId, convId],
  );

// --- what the steps of a turn show -------------------------------------------------

// How many reads in a row fold into one row.
const FOLD_AT = 4;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The steps, with every run of FOLD_AT or more document reads in a row drawn
// as one row: `{steps}` for a step on its own, `{run: [steps]}` for a run. A
// read with text before it starts a new run, so no text is folded away.
export const foldReads = (steps) => {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= FOLD_AT) out.push({ run });
    else out.push(...run.map((s) => ({ step: s })));
    run = [];
  };
  for (const s of steps || []) {
    const read = s.kind === 'document' && !s.failed;
    if (read && !(run.length && s.said)) run.push(s);
    else {
      flush();
      if (read) run.push(s);
      else out.push({ step: s });
    }
  }
  flush();
  return out;
};

// The row a run of reads folds into: `Read 43 sentences in 9 documents`.
export const runLabel = (run) => {
  const docs = new Set(run.map((s) => s.document).filter(Boolean)).size || run.length;
  const sentences = run
    .flatMap((s) => s.saw || [])
    .filter((n) => n.unit === 'sentence')
    .reduce((a, n) => a + (n.n || 0), 0);
  return sentences
    ? `Read ${plural(sentences, 'sentence', 'sentences')} in ${plural(docs, 'document', 'documents')}`
    : `Read ${plural(docs, 'document', 'documents')}`;
};

// A tool call's arguments as the reader is shown them: `{code}` for code the
// model ran, `{query}` for a query, `{lines}` of `name: value` otherwise, or
// `{raw}` for arguments that are not a JSON object.
export const callInput = (name, raw) => {
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    return { raw: String(raw ?? '') };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { raw: String(raw ?? '') };
  const shown = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const rest = (skip) =>
    Object.entries(args)
      .filter(([k]) => k !== skip)
      .map(([k, v]) => [k, shown(v)]);
  if (name === 'run_code' && typeof args.code === 'string')
    return { code: args.code, lines: rest('code') };
  if (name === 'query' && args.query !== undefined)
    return { query: shown(args.query), lines: rest('query') };
  return { lines: rest(null) };
};

// The call a step was, in its round.
export const callOf = (round, step) => (round?.calls || []).find((c) => c.id === step.id) || null;
