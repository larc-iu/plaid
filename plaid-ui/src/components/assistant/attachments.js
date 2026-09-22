// The files a reader attaches to a message: what is accepted, where the text
// is kept, and what the message carries instead of it.
//
// A file lives BESIDE the conversation, in the same private key/value store the
// record lives in, one key per part:
//
//   <app>:assistant:<project>:file:<conversation>:<file>:part:<n>
//
// and the message carries only the reference, `{id, name, bytes, lines,
// chunks}`, on its own display item. The text is deliberately not in the
// record: everything in the record is sent to the model on every later turn, so
// a table of ten thousand rows put there would be paid for once a turn for the
// rest of the conversation. The service resolves the reference against the same
// keys and reads what a turn actually needs
// (plaid-agent/src/plaid_agent/core/files.py).
//
// Nothing is written until the message is SENT. A file picked and then thought
// better of leaves nothing behind, and the parts are written under the
// conversation the message actually goes to rather than whichever one was open
// when the paperclip was clicked.

// What can be attached. Text, in the sense that a person could open it in an
// editor and read it: the assistant reads a table as rows and everything else
// as lines, and neither can do anything with bytes it cannot decode.
//
// The interchange formats are here because refusing them is worse than reading
// them: someone who drags a .conllu in wants to be told what is in it, and the
// assistant saying "this belongs in the import screen" is a better answer than
// the composer refusing the file with no explanation at all.
export const ACCEPT = [
  '.csv',
  '.tsv',
  '.tab',
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.conllu',
  '.flextext',
  '.eaf',
  '.lift',
  '.umr',
];

// Files one message may carry. The note the service writes names every one of
// them and shows the first lines of each, so this is what keeps that note a
// note. Someone with more than five files to ask about has a folder, and a
// folder is a question for the import screens.
export const MAX_FILES = 5;

// The most one file may be. Not a storage limit (the parts are as many as they
// need to be) but a reading one: past this the assistant is being handed a
// corpus rather than a question about one, and the import screens are what a
// corpus is for.
export const MAX_BYTES = 4_000_000;

// What one stored value may weigh when the server does not say. The real cap is
// the server's and it publishes it at /info.
const VALUE_BYTES = 1_000_000;

// Room left under the cap for the key and for the store's own rounding. The
// measure below is exact, so this is small on purpose.
const HEADROOM = 1024;

// An orphan is a file whose conversation does not exist. It can only happen
// when a send got as far as writing the parts and no further, so a file younger
// than this is much more likely to be one still being written than one left
// behind.
const ORPHAN_AGE_MS = 60 * 60 * 1000;

const filePrefix = (app, projectId, convId) => `${app}:assistant:${projectId}:file:${convId}:`;

const allFilesPrefix = (app, projectId) => `${app}:assistant:${projectId}:file:`;

const partKey = (app, projectId, convId, fileId, n) =>
  `${filePrefix(app, projectId, convId)}${fileId}:part:${n}`;

// Which conversation a file key belongs to. The conversation is IN the key, so
// a listing of keys alone says what belongs to what: nothing has to be read to
// find out, and a listing with values would drag down every part of every file.
export const convOfFileKey = (app, projectId, key) => {
  const head = allFilesPrefix(app, projectId);
  if (typeof key !== 'string' || !key.startsWith(head)) return null;
  const cut = key.slice(head.length).indexOf(':');
  return cut > 0 ? key.slice(head.length, head.length + cut) : null;
};

const suffixOf = (name) => {
  const cut = (name || '').lastIndexOf('.');
  return cut > 0 ? name.slice(cut).toLowerCase() : '';
};

// Why this file cannot be attached, or null. One sentence, naming the remedy:
// it is shown where the file was dropped.
export const refuse = (file) => {
  const name = file?.name || '';
  if (!ACCEPT.includes(suffixOf(name))) {
    return `${name || 'That file'} is not a kind the assistant can read. It reads text: ${ACCEPT.join(', ')}.`;
  }
  if ((file?.size ?? 0) > MAX_BYTES) {
    return `${name} is ${Math.round(file.size / 1_000_000)} MB, over the ${MAX_BYTES / 1_000_000} MB limit for an attachment. Import a file this size from the project's import screen instead.`;
  }
  return null;
};

// What the SERVER counts for a stored string, not what JavaScript would.
//
// The store measures its own JSON, which escapes every non-ASCII character as
// \uXXXX and every "/" as \/, so a Cyrillic table weighs six times what its
// characters suggest. Counted the easy way a file sat comfortably under the cap
// and the write came back 413. (plaid_agent/core/conversation.py says the same
// thing from the other side, for the same reason.)
const costOf = (code) => {
  if (code > 0x7e) return 6; // \uXXXX, and a surrogate pair is two of them
  if (code === 0x22 || code === 0x5c || code === 0x2f) return 2; // " \ /
  if (code < 0x20) {
    return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
      ? 2
      : 6;
  }
  return 1;
};

export const storedBytes = (text) => {
  let n = 2; // the quotes around it
  for (let i = 0; i < text.length; i += 1) n += costOf(text.charCodeAt(i));
  return n;
};

// The text cut into parts that each fit one stored value, in order. A cut never
// falls between a surrogate pair: half of one is not a character, and the two
// halves would not survive the round trip through the store.
export const chunk = (text, budget) => {
  const parts = [];
  let start = 0;
  let cost = 2;
  for (let i = 0; i < text.length; i += 1) {
    const c = costOf(text.charCodeAt(i));
    if (cost + c > budget && i > start) {
      const prev = text.charCodeAt(i - 1);
      const cut = prev >= 0xd800 && prev <= 0xdbff ? i - 1 : i;
      if (cut > start) {
        parts.push(text.slice(start, cut));
        start = cut;
        i = cut - 1;
        cost = 2;
        continue;
      }
    }
    cost += c;
  }
  parts.push(text.slice(start));
  return parts;
};

// A file's size as a person writes it. The same phrasing the service uses in
// the note it writes for the model (plaid_agent/core/filetools.py), so the chip
// and the answer beside it say the same number the same way.
export const fileSize = (n) => {
  if (!n) return '';
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
};

// How many lines a person would say the file has: one that ends in a newline
// does not have a last, empty one. The service counts them the same way, and
// the two numbers are shown side by side (the chip here, the note there).
export const lineCount = (text) => {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
};

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `f${Date.now()}${Math.random().toString(16).slice(2)}`;

// A file the browser cannot read as UTF-8. Excel on Windows writes CSV as
// cp1252 unless "CSV UTF-8" is picked, and `file.text()` decodes leniently:
// every accented letter comes through as U+FFFD, the chip says nothing, the
// note the service writes shows the damage as if it were the file's contents,
// and the model then plans writes over forms that are not the ones in the
// file. So the decode is strict and the file is refused by name.
export class NotUtf8Error extends Error {
  constructor(name) {
    super(`${name} is not UTF-8 text. Save it as UTF-8 and attach it again.`);
    this.name = 'NotUtf8Error';
  }
}

// `fatal: true` throws on the first byte that is not UTF-8 rather than
// standing a replacement character in for it. A UTF-8 BOM is still stripped
// (`ignoreBOM` is false by default), which is what the service does too.
const decodeUtf8 = (buffer, name) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new NotUtf8Error(name || 'That file');
  }
};

// One picked file, read and measured, waiting for the message it belongs to.
// It holds the TEXT, which is what makes it pending: nothing of it is stored
// until the message is sent.
export const readAttachment = async (file, budget = VALUE_BYTES - HEADROOM) => {
  const text = decodeUtf8(await file.arrayBuffer(), file.name);
  return {
    id: newId(),
    name: file.name,
    text,
    bytes: new TextEncoder().encode(text).length,
    lines: lineCount(text),
    parts: chunk(text, budget),
  };
};

// What the message carries: everything the service needs to find the parts and
// everything the chat needs to draw the chip, and none of the text.
export const refOf = (pending) => ({
  id: pending.id,
  name: pending.name,
  bytes: pending.bytes,
  lines: pending.lines,
  chunks: pending.parts.length,
});

// The cap the server enforces on one stored value, which it publishes. A server
// that does not report one, or will not answer, gets the fallback: the write
// would be refused with a readable error anyway, and refusing to attach
// anything because /info was slow is worse.
export const valueBudget = async (client) => {
  try {
    const limits = (await client.server.limits()) || {};
    const cap = limits.userDataValueBytes;
    return (Number.isInteger(cap) && cap > 0 ? cap : VALUE_BYTES) - HEADROOM;
  } catch {
    return VALUE_BYTES - HEADROOM;
  }
};

// Write the parts of every pending file under one conversation. Called from the
// job that sends the message, before the record is written, so a file that
// cannot be stored stops the message rather than going with it as a reference
// to nothing.
export const uploadAttachments = async (store, convId, pending) => {
  const { client, userId, app, projectId } = store;
  if (!userId || !pending?.length) return;
  for (const file of pending) {
    for (let n = 0; n < file.parts.length; n += 1) {
      // In order, and awaited: a 1 MB value apiece, and the store is the same
      // one the conversation itself is about to be written to.
      await client.userData.put(userId, partKey(app, projectId, convId, file.id, n), file.parts[n]);
    }
  }
};

// Every key a conversation's files are stored under. Listed rather than worked
// out from the record, so a file whose reference never reached the record (a
// send that failed between the two writes) is still found and still deleted.
const fileKeysOf = async (store, projectId, convId) => {
  const { client, userId, app } = store;
  const entries = await client.userData.list(userId, {
    prefix: filePrefix(app, projectId, convId),
    pageSize: 1000,
  });
  return (entries || []).map((e) => e.key);
};

// Delete everything attached to one conversation. Part of deleting it: a
// transcript is gone from the moment its keys are, and its files would
// otherwise sit in the store with nothing left that names them.
export const deleteConversationFiles = async (store, projectId, convId) => {
  const { client, userId } = store;
  if (!userId) return;
  const keys = await fileKeysOf(store, projectId, convId);
  await Promise.all(keys.map((key) => client.userData.delete(userId, key).catch(() => {})));
};

// Files left by a send that wrote the parts and then could not write the
// record. Nothing else can make one: the parts are written inside the send, and
// a conversation that is deleted takes its files with it.
//
// `liveIds` is every conversation this project has. A listing of KEYS is enough
// to find the rest, so this costs one narrow read and usually deletes nothing.
const swept = new Set();

// For a test: the guard above is a page-load's worth of memory, not a fact
// about the store.
export const resetSweep = () => swept.clear();

export const sweepOrphanFiles = async (store, liveIds) => {
  const { client, userId, app, projectId } = store;
  if (!userId) return 0;
  // Once per project per page load. Nothing makes an orphan while the page is
  // open except a failure this same page just reported.
  const tag = `${app}:${projectId}`;
  if (swept.has(tag)) return 0;
  swept.add(tag);
  const entries = await client.userData.list(userId, {
    prefix: allFilesPrefix(app, projectId),
    pageSize: 1000,
  });
  const live = new Set(liveIds || []);
  const old = Date.now() - ORPHAN_AGE_MS;
  const doomed = (entries || []).filter((e) => {
    const conv = convOfFileKey(app, projectId, e.key);
    if (!conv || live.has(conv)) return false;
    // A file younger than the window is most likely one being written right
    // now, by this tab or another.
    const at = Date.parse(e.updatedAt || '');
    return !Number.isFinite(at) || at < old;
  });
  await Promise.all(doomed.map((e) => client.userData.delete(userId, e.key).catch(() => {})));
  return doomed.length;
};
