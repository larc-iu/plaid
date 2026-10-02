// A server for the Media tab's segment writes and the Baseline tab's text
// edits, in memory, with the client that talks to it. It keeps a stored
// document, answers every read with it, and applies the text and token writes
// these tabs send, as the core does:
//
// - A text write whose `base` is not the digest of the body stored is refused
//   409, `text-changed`. An edit's tokens follow a stand-in for the core's
//   rule (`takeEdit`), not the rule itself, which the core's own tests hold.
// - Strict mode: the stored document has a version, which every write moves
//   on, and a write the client stamps with a version that is not the stored
//   one is refused 409 (a batch is checked at its first stamped write). The
//   client stamps every write with the version it last heard, unless the
//   write says `versioned: false` (a text write with a `base` and no
//   `versioned`, as plaid-client has it).
// - Idempotency: inside an operation opened with `keys` (`keySeed()`), the
//   nth write takes the key `<seed>.<n>` and the stamp its first run claimed,
//   as plaid-client numbers them. A write answered 2xx is kept under its key:
//   the same request sent again under it is answered from what it stored,
//   another request under it is refused 422 `idempotency-key-reused`.
// - A write whose answer the client's own resend gets (`replayNext`) is
//   stored, and answered from what it stored, marked as replayed, as
//   plaid-client marks it (`wasReplayed`).
// - A create that names its id is made under it, and refused 409 `id-taken`
//   when a row had that id.
// - A batch is atomic: when one of its writes is refused, nothing of it is
//   stored.
//
// `other` writes as another user, with an entry in the audit log naming the
// rows it wrote, so a toast can say who changed a segment. Not imported by app
// code.

import { createHash } from 'node:crypto';
import { composeTextEdits } from '@larc-iu/plaid-client';
import {
  applyGapsLocally,
  applyTextEditsLocally,
  removeTokensLocally,
} from '@/domain/textEdits.js';
import { makeFakeClient } from '@/domain/test-helpers.js';

export const digestOf = (body) => createHash('sha256').update(body, 'utf8').digest('hex');

const textOf = (raw) => raw.textLayers[0].text;
const layersOf = (raw) => raw.textLayers[0].tokenLayers;
const layerOf = (raw, id) => layersOf(raw).find((l) => l.id === id);
const refused = (status, data) =>
  Object.assign(new Error(`HTTP ${status} ${data.error}`), { status, responseData: data });
const VERSION_MISMATCH = 'Document version mismatch.';

// `value` marked as an answer replayed from its key's first send, as
// plaid-client marks it.
const markReplayed = (value) => {
  if (value !== null && typeof value === 'object') {
    Object.defineProperty(value, 'replayed', { value: true, enumerable: false });
  }
  return value;
};

// Every id the stored document holds.
const idsIn = (raw) => {
  const ids = new Set();
  for (const layer of layersOf(raw)) {
    for (const t of layer.tokens || []) ids.add(t.id);
    for (const sl of layer.spanLayers || []) for (const s of sl.spans || []) ids.add(s.id);
    for (const v of layer.vocabs || []) for (const l of v.vocabLinks || []) ids.add(l.id);
  }
  return ids;
};

// The vocabularies the raw tree carries on its token layers, by id, for the
// cascade mirror to sweep in place.
const vocabsIn = (raw) =>
  Object.fromEntries(
    layersOf(raw)
      .flatMap((l) => l.vocabs || [])
      .map((v) => [v.id, v]),
  );

// What a text edit did, as the core's answer lists it: token extents, span
// and link token lists that moved, and every row it deleted.
function reshapeOf(before, after) {
  const rows = (raw) => {
    const tokens = new Map();
    const spans = new Map();
    const links = new Map();
    for (const layer of layersOf(raw)) {
      for (const t of layer.tokens || []) tokens.set(t.id, t);
      for (const sl of layer.spanLayers || []) for (const s of sl.spans || []) spans.set(s.id, s);
      for (const v of layer.vocabs || []) for (const l of v.vocabLinks || []) links.set(l.id, l);
    }
    return { tokens, spans, links };
  };
  const was = rows(before);
  const now = rows(after);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const gone = (kind) => [...was[kind].keys()].filter((id) => !now[kind].has(id));
  const moved = (kind, pick) =>
    [...now[kind].values()]
      .filter((row) => was[kind].has(row.id) && !same(pick(was[kind].get(row.id)), pick(row)))
      .map((row) => ({ id: row.id, ...pick(row) }));
  return {
    tokens: moved('tokens', (t) => ({ begin: t.begin, end: t.end })),
    spans: moved('spans', (s) => ({ tokens: s.tokens })),
    vocabLinks: moved('links', (l) => ({ tokens: l.tokens })),
    deleted: {
      tokens: gone('tokens'),
      spans: gone('spans'),
      relations: [],
      vocabLinks: gone('links'),
    },
  };
}

// An edit's gaps as this fake takes them: the body changed and every token
// moved or resized by the change beside or inside it, as the app shows an edit
// before the server answers (`applyGapsLocally`). Text typed with no space in
// it at a token's edge joins the token on the `side` the op names, as the
// client asks of the core, and a token left with no text is deleted, with what
// hangs off it. That is all. It is NOT the core's rule (plaid-core
// `apply-plain-gaps`), which decides which word new text joins and which words
// an edit deletes where the client names no side: those are tested in the core
// (`plain_edits_test.clj` and its oracles). The tests here are of what the app
// sends and what it does with the server's answer.
function takeEdit(raw, textId, gaps, vocabs) {
  const textLayer = raw.textLayers.find((tl) => tl.text?.id === textId);
  for (const gap of [...gaps].reverse()) {
    applyGapsLocally(raw, textId, [gap]);
    const n = [...gap.value].length;
    if (gap.start !== gap.end || !n || /\s/u.test(gap.value) || !gap.side) continue;
    for (const layer of textLayer.tokenLayers || []) {
      for (const t of layer.tokens || []) {
        if (gap.side === 'before' && t.begin < gap.start && t.end === gap.start) t.end += n;
        if (gap.side === 'after' && t.begin === gap.start + n && t.end > t.begin) t.begin -= n;
      }
    }
  }
  const gone = [];
  for (const layer of textLayer.tokenLayers || []) {
    for (const t of layer.tokens || []) if (t.begin >= t.end) gone.push(t.id);
  }
  if (gone.length) removeTokensLocally(raw, textId, gone, vocabs);
}

// The writes the two tabs send, applied to `raw` in place. Each answers what
// the server answers.
const writesOn = (raw, { mint, claim }) => {
  const checkBase = (base) => {
    const digest = digestOf(textOf(raw).body);
    if (base != null && base !== digest) {
      throw refused(409, {
        error: 'The text was changed since it was read.',
        'text-changed': true,
        digest,
      });
    }
  };
  return {
    'texts.update': (textId, ops, auditMessage, { base } = {}) => {
      checkBase(base);
      const text = textOf(raw);
      if (typeof ops === 'string') {
        text.body = ops;
      } else {
        applyTextEditsLocally(raw, textId, ops, vocabsIn(raw));
      }
      text.digest = digestOf(text.body);
      return { id: textId, body: text.body, digest: text.digest };
    },
    'texts.edit': (textId, ops, auditMessage, { base } = {}) => {
      checkBase(base);
      const before = structuredClone(raw);
      // The side an op was typed on stays with its gap (one gap per op here).
      const gaps = composeTextEdits(textOf(raw).body, ops);
      if (gaps.length === ops.length) gaps.forEach((g, i) => ops[i].side && (g.side = ops[i].side));
      takeEdit(raw, textId, gaps, vocabsIn(raw));
      const text = textOf(raw);
      text.digest = digestOf(text.body);
      return { id: textId, body: text.body, digest: text.digest, reshape: reshapeOf(before, raw) };
    },
    'tokens.create': (layerId, textId, begin, end, precedence, metadata, auditMessage, opts) => {
      const id = claim(opts?.id) ?? mint();
      const layer = layerOf(raw, layerId);
      layer.tokens.push({ id, text: textId, begin, end, metadata: metadata ?? {} });
      layer.tokens.sort((a, b) => a.begin - b.begin);
      return { id };
    },
    'tokens.bulkCreate': (list) => {
      const ids = list.map((t) => {
        const id = claim(t.id) ?? mint();
        layerOf(raw, t.tokenLayerId).tokens.push({
          id,
          text: t.text,
          begin: t.begin,
          end: t.end,
        });
        return id;
      });
      return { ids };
    },
    'tokens.delete': (id) => {
      const layer = layersOf(raw).find((l) => l.tokens.some((t) => t.id === id));
      // What strict mode answers for a row that is gone.
      if (!layer) {
        throw refused(409, {
          error: `${VERSION_MISMATCH} What this request names is no longer in the document.`,
        });
      }
      layer.tokens = layer.tokens.filter((t) => t.id !== id);
      return {};
    },
    'tokens.update': (id, begin, end) => {
      const token = layersOf(raw)
        .flatMap((l) => l.tokens)
        .find((t) => t.id === id);
      if (!token) {
        throw refused(409, {
          error: `${VERSION_MISMATCH} What this request names is no longer in the document.`,
        });
      }
      const layer = layersOf(raw).find((l) => (l.tokens || []).includes(token));
      const [b, e] = [begin ?? token.begin, end ?? token.end];
      if (
        layer.overlapMode === 'non-overlapping' &&
        layer.tokens.some((t) => t !== token && t.begin < e && b < t.end)
      ) {
        throw refused(409, { error: 'Updated token would overlap another token in the layer.' });
      }
      token.begin = b;
      token.end = e;
      return {};
    },
    'tokens.patchMetadata': (id, ops) => {
      const token = layersOf(raw)
        .flatMap((l) => l.tokens)
        .find((t) => t.id === id);
      if (!token) throw refused(404, { error: 'Not found.' });
      const metadata = { ...(token.metadata || {}) };
      for (const op of ops) {
        if (op.op === 'delete') delete metadata[op.path[0]];
        else metadata[op.path[0]] = op.value;
      }
      token.metadata = metadata;
      return {};
    },
  };
};

// What the audit log says of `ops` ([kind, args] pairs), naming the tokens.
const described = (ops) =>
  ops.map(([kind, args]) =>
    kind.startsWith('texts.')
      ? { description: 'Edit body of text' }
      : { description: `${kind === 'tokens.create' ? 'Create' : 'Update'} token ${args[0]}` },
  );

// Whether a write goes stamped with the document version (see the header).
const stamped = (kind, args) => {
  if (kind !== 'texts.update' && kind !== 'texts.edit') return true;
  const { base, versioned } = args[3] ?? {};
  return versioned ?? base == null;
};

export function segmentServer(raw) {
  let stored = structuredClone(raw);
  textOf(stored).digest = digestOf(textOf(stored).body);
  let version = 1;
  // Every id the server has held, deleted ones too: a create may not reuse one.
  const everHeld = idsIn(stored);
  let n = 0;
  const mint = () => `seg-${++n}`;
  const audit = [];
  // Every request this page sent that writes: `{ kind, args, key, stamp }`,
  // a batch as one entry of kind 'batch' whose `ops` are its writes.
  const sentHere = [];
  // Refusals to answer the next writes with, before any is applied.
  const refusals = [];
  // Writes applied whose answer is then lost (status 0).
  let lose = 0;
  // Writes applied whose answer the client's own resend gets, refused with
  // one of these statuses (a 500, a 403 before the key is looked up).
  const refusedAfter = [];
  // Writes applied whose answer the client's own resend gets, replayed: what
  // to run between the first send and the resend, for each.
  const replays = [];
  // Idempotency-Key -> { fingerprint, results }.
  const keyed = new Map();

  // A page's client: `user` null for this page, whose writes are `sent`, or
  // another user's page (`connect`), whose writes the audit log names as theirs.
  const connect = (user = null) => {
    const sent = user == null ? sentHere : [];
    const client = makeFakeClient();

    // What the client knows: the version it last heard, and the key frames of
    // the operations open, as plaid-client keeps them.
    let held = version;
    const frames = [];
    let seeds = 0;
    client.keySeed = () => ({ seed: `seed-${user ?? ''}${++seeds}`, stamps: new Map() });
    client.withOperation = async (message, fn, { keys } = {}) => {
      const opened = keys || frames.length === 0;
      if (opened) frames.push({ keys: keys ?? null, count: 0 });
      try {
        return await fn(() => {});
      } finally {
        if (opened) frames.pop();
      }
    };
    // The key of the next write, and the version it claims (null for one that
    // claims none), pinned by the first run of its operation.
    const nextKey = (claims) => {
      const frame = frames.at(-1);
      const now = claims ? held : null;
      if (!frame?.keys) return { key: null, stamp: now };
      const i = frame.count;
      frame.count += 1;
      const { stamps } = frame.keys;
      if (!stamps.has(i)) stamps.set(i, now);
      return { key: `${frame.keys.seed}.${i}`, stamp: stamps.get(i) };
    };

    client.documents.get = async () => {
      held = version;
      return structuredClone(stored);
    };
    client.documents.auditPage = async () => ({ entries: [...audit].reverse() });

    // Send `ops` ([kind, args] pairs) as one request, all or nothing, and
    // record it in `sent` as `item` with its key, stamp and answer.
    const request = (item, ops) => {
      const checkAt = ops.findIndex(([kind, args]) => stamped(kind, args));
      const { key, stamp } = nextKey(checkAt >= 0);
      const entry = { ...item, key, stamp, answer: null };
      sent.push(entry);
      const fingerprint = JSON.stringify([ops, stamp]);
      if (key && keyed.has(key)) {
        const kept = keyed.get(key);
        if (kept.fingerprint !== fingerprint) {
          entry.answer = 422;
          throw refused(422, {
            error: 'idempotency-key-reused',
            'idempotency-key-reused': true,
          });
        }
        entry.answer = 'replayed';
        return structuredClone(kept.results);
      }
      try {
        if (refusals.length) throw refusals.shift();
        const draft = structuredClone(stored);
        const claimed = new Set();
        const claim = (id) => {
          if (id == null) return null;
          if (everHeld.has(id) || claimed.has(id)) {
            throw refused(409, {
              error: 'id-taken',
              'id-taken': true,
              id,
              message: `A token with id ${id} already exists.`,
            });
          }
          claimed.add(id);
          return id;
        };
        const on = writesOn(draft, { mint, claim });
        const results = ops.map(([kind, args], i) => {
          if (i === checkAt && stamp !== version) throw refused(409, { error: VERSION_MISMATCH });
          return { status: 200, body: on[kind](...args) };
        });
        stored = draft;
        for (const id of idsIn(stored)) everHeld.add(id);
        version += 1;
        if (key) keyed.set(key, { fingerprint, results: structuredClone(results) });
        if (lose > 0) {
          lose -= 1;
          entry.answer = 'lost';
          throw Object.assign(new Error('Network error'), { status: 0, method: 'POST' });
        }
        if (refusedAfter.length) {
          const status = refusedAfter.shift();
          entry.answer = `stored, then ${status} in the client`;
          throw refused(status, { error: 'Injected' });
        }
        held = version;
        if (replays.length) {
          const between = replays.shift();
          entry.answer = 'replayed in the client';
          between?.();
          const replayed = structuredClone(results);
          for (const r of replayed) markReplayed(r.body);
          return markReplayed(replayed);
        }
        entry.answer = 200;
        if (user != null)
          audit.push({ user: { id: user, displayName: user }, ops: described(ops) });
        return results;
      } catch (err) {
        entry.answer ??= err.status;
        throw err;
      }
    };

    const BATCHED = [
      'texts.update',
      'texts.edit',
      'tokens.create',
      'tokens.update',
      'tokens.delete',
      'tokens.bulkCreate',
      'tokens.patchMetadata',
    ];
    client.batched = async (fn) => {
      const ops = [];
      const queue =
        (kind) =>
        (...args) => {
          ops.push([kind, args]);
        };
      const b = { texts: {}, tokens: {} };
      for (const kind of BATCHED) {
        const [group, method] = kind.split('.');
        b[group][method] = queue(kind);
      }
      await fn(b);
      return request({ kind: 'batch', ops: ops.map(([kind, args]) => ({ kind, args })) }, ops);
    };
    for (const kind of BATCHED) {
      const [group, method] = kind.split('.');
      client[group][method] = async (...args) => request({ kind, args }, [[kind, args]])[0].body;
    }

    return client;
  };
  const client = connect();

  // A write as another user, straight to the store: the version moves on, and
  // the audit log names the rows it wrote.
  const other = (user, write) => {
    const on = writesOn(stored, { mint, claim: (id) => id ?? null });
    const out = write(on);
    for (const id of idsIn(stored)) everHeld.add(id);
    version += 1;
    audit.push({ user: { id: user, displayName: user }, ops: out.ops });
    return out.value;
  };

  return {
    client,
    sent: sentHere,
    // Another user's page on the same document: its own client.
    connect: (user = 'b') => connect(user),
    get stored() {
      return stored;
    },
    get body() {
      return textOf(stored).body;
    },
    get digest() {
      return textOf(stored).digest;
    },
    get version() {
      return version;
    },
    segments: () => layerOf(stored, 'alignL').tokens,
    // The requests sent that wrote something, by their answer.
    answers: () => sentHere.map((r) => r.answer),
    // Refuse the next write with `status` (a document version that moved,
    // with the body unchanged).
    refuseNext: (status = 409, error = VERSION_MISMATCH) =>
      refusals.push(refused(status, { error })),
    // Store the next `count` writes and lose their answers.
    loseNext: (count = 1) => {
      lose += count;
    },
    // Store the next write, run `between()` (another user's write, say), and
    // answer the write as the client's own resend is answered: from what it
    // stored, marked as replayed.
    replayNext: (between = null) => {
      replays.push(between);
    },
    // Store the next write and answer it as the client's own resend of it is
    // refused: with `status`, which does not say the first send landed.
    storeThenRefuse: (status = 500) => {
      refusedAfter.push(status);
    },
    // Another user's edit of the segment `id`'s text, as the Media tab makes
    // it: the text typed over, and the segment, which keeps its id, set over
    // the new text.
    otherEdits(id, value, user = 'b') {
      return other(user, (on) => {
        const segment = layerOf(stored, 'alignL').tokens.find((t) => t.id === id);
        on['texts.edit'](textOf(stored).id, [
          { type: 'replace', index: segment.begin, length: segment.end - segment.begin, value },
        ]);
        on['tokens.update'](id, segment.begin, segment.begin + [...value].length);
        return {
          value: id,
          ops: [{ description: 'Edit body of text' }, { description: `Update token ${id}` }],
        };
      });
    },
    // Another user's segment `id` deleted with its text and made again over
    // the same time with `value`: another segment, whose id is new.
    otherRemakes(id, value, user = 'b') {
      return other(user, (on) => {
        const segment = layerOf(stored, 'alignL').tokens.find((t) => t.id === id);
        on['texts.update'](textOf(stored).id, [
          { type: 'delete', index: segment.begin, value: segment.end - segment.begin },
          { type: 'insert', index: segment.begin, value },
        ]);
        const { id: made } = on['tokens.create'](
          'alignL',
          textOf(stored).id,
          segment.begin,
          segment.begin + [...value].length,
          undefined,
          segment.metadata,
        );
        return {
          value: made,
          ops: [{ description: `Delete token ${id}` }, { description: `Create token ${made}` }],
        };
      });
    },
    // Another user's Baseline save that retypes the segment `id`'s text as
    // `value` in place: typed inside it and what it replaces deleted around
    // that, so the segment keeps its id, as a save by edits does.
    otherRetypes(id, value, user = 'b') {
      const segment = layerOf(stored, 'alignL').tokens.find((t) => t.id === id);
      const length = segment.end - segment.begin;
      const typed = [...value].length;
      return this.otherSaves(
        [
          { type: 'insert', index: segment.begin + 1, value },
          { type: 'delete', index: segment.begin + 1 + typed, value: length - 1 },
          { type: 'delete', index: segment.begin, value: 1 },
        ],
        user,
      );
    },
    // Another user's change of the segment `id`'s speaker or times: token
    // metadata, the body as it was.
    otherRelabels(id, patch, user = 'b') {
      return other(user, (on) => {
        const ops = Object.entries(patch).map(([key, value]) =>
          value == null ? { op: 'delete', path: [key] } : { op: 'set', path: [key], value },
        );
        on['tokens.patchMetadata'](id, ops);
        return { value: id, ops: [{ description: `Update token ${id}` }] };
      });
    },
    // Another user's save of the whole body in the Baseline tab, as a text
    // edit: `edits` are running ops (plaid-client `applyTextOps`).
    otherSaves(edits, user = 'b') {
      return other(user, (on) => {
        on['texts.edit'](textOf(stored).id, edits);
        return { value: textOf(stored).body, ops: [{ description: 'Edit body of text' }] };
      });
    },
  };
}
