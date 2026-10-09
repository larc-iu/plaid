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
// Nothing is stored until the message is SENT. The page cuts the text into
// parts and asks the assistant service to store them (`attach`, one request a
// file, plaid_agent/core/ops.py), under the conversation the message actually
// goes to rather than whichever one was open when the paperclip was clicked.
// A file picked and then thought better of leaves nothing behind.

import { statusOf } from '../../lib/errors.js';
import { decodeText, NotUtf8FileError } from '../../lib/textFile.js';
import { pdfText } from './pdfText.js';
import { uuidv4 } from '../../../../plaid-client-js/src/ids.js';

// What can be attached. Text, in the sense that a person could open it in an
// editor and read it: the assistant reads a table as rows and everything else
// as lines, and neither can do anything with bytes it cannot decode.
//
// The interchange formats are here because refusing them is worse than reading
// them: someone who drags a .conllu in wants to be told what is in it, and the
// assistant saying "this belongs in the import screen" is a better answer than
// the composer refusing the file with no explanation at all.
//
// A PDF is read here, in the browser, into text with its pages and sections
// marked (pdfText.js), and from then on it is a text file like the others.
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
  '.pdf',
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

// The largest PDF read. It is held to MAX_BYTES by the text taken out of it,
// since a PDF's size is mostly fonts and figures; this bounds what the browser
// has to hold to get at that text.
export const MAX_PDF_BYTES = 100_000_000;

// What one stored value may weigh when the server does not say. The real cap is
// the server's and it publishes it at /info.
const VALUE_BYTES = 1_000_000;

// Room left under the cap for the key and for the store's own rounding. The
// measure below is exact, so this is small on purpose.
const HEADROOM = 1024;

const filePrefix = (app, projectId, convId) => `${app}:assistant:${projectId}:file:${convId}:`;

const partKey = (app, projectId, convId, fileId, n) =>
  `${filePrefix(app, projectId, convId)}${fileId}:part:${n}`;

const suffixOf = (name) => {
  const cut = (name || '').lastIndexOf('.');
  return cut > 0 ? name.slice(cut).toLowerCase() : '';
};

// Why this file cannot be attached, or null. One sentence, naming the remedy:
// it is shown where the file was dropped.
export const refuse = (file) => {
  const name = file?.name || '';
  const suffix = suffixOf(name);
  if (!ACCEPT.includes(suffix)) {
    return `${name || 'That file'} is not a kind the assistant can read. It reads ${ACCEPT.join(', ')}.`;
  }
  if (suffix === '.pdf') {
    return (file?.size ?? 0) > MAX_PDF_BYTES
      ? `${name} is ${Math.round(file.size / 1_000_000)} MB, over the ${MAX_PDF_BYTES / 1_000_000} MB limit for a PDF.`
      : null;
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

const newId = uuidv4;

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

// The shared reader, strict: a byte that is not valid in the file's encoding
// refuses the file rather than standing a replacement character in for it. A
// UTF-16 file is read by its byte order mark, a UTF-8 mark is stripped (which
// is what the service does too), and a NUL (UTF-16 with no mark) refuses it.
const decodeFile = (buffer, name) => {
  try {
    return decodeText(buffer, name);
  } catch (e) {
    if (e instanceof NotUtf8FileError) throw new NotUtf8Error(name || 'That file');
    throw e;
  }
};

// A PDF that cannot be attached, said by name in one sentence.
export class PdfAttachError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PdfAttachError';
  }
}

// pdf.js, loaded the first time a PDF is picked, so the apps carry none of it
// until then. Its worker comes from the app's own build.
const loadPdfjs = async () => {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
};

// A PDF's text, with its pages and sections marked, or a refusal naming the
// file: a scan has no text to read, and the text is held to MAX_BYTES.
const readPdfText = async (buffer, name, loadPdf = loadPdfjs) => {
  const pdfjs = await loadPdf();
  let doc;
  try {
    // Errors only: a font pdf.js cannot fully interpret is reported to the
    // console as a warning, and the text is read regardless.
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') {
      throw new PdfAttachError(`${name} is locked with a password.`);
    }
    throw new PdfAttachError(`${name} could not be opened as a PDF.`);
  }
  try {
    const got = await pdfText(doc);
    if (got.scan) {
      throw new PdfAttachError(
        `${name} has no text in it (a scan). Only PDFs with text can be read.`,
      );
    }
    const bytes = new TextEncoder().encode(got.text).length;
    if (bytes > MAX_BYTES) {
      throw new PdfAttachError(
        `${name} holds ${(bytes / 1_000_000).toFixed(1)} MB of text, over the ${MAX_BYTES / 1_000_000} MB limit for an attachment.`,
      );
    }
    return got.text;
  } finally {
    doc.destroy?.();
  }
};

// One picked file, read and measured, waiting for the message it belongs to.
// It holds the TEXT, which is what makes it pending: nothing of it is stored
// until the message is sent.
export const readAttachment = async (
  file,
  budget = VALUE_BYTES - HEADROOM,
  loadPdf = loadPdfjs,
) => {
  const text =
    suffixOf(file.name) === '.pdf'
      ? await readPdfText(await file.arrayBuffer(), file.name, loadPdf)
      : decodeFile(await file.arrayBuffer(), file.name);
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

// A file a reply made for the user (the assistant's save_file), read back whole.
// Its parts are where an attachment's are, and its reference rides on the reply
// with `made: true`.
export const readStoredFile = async (store, convId, file) => {
  const { client, userId, app, projectId } = store;
  const parts = [];
  for (let n = 0; n < Math.max(1, file.chunks || 1); n += 1) {
    // The store answers a missing key with a 404, which would otherwise reach
    // the person as a bare "Not found."
    const got = await client.userData
      .get(userId, partKey(app, projectId, convId, file.id, n))
      .catch((e) => {
        if (statusOf(e) === 404) return null;
        throw e;
      });
    if (typeof got?.value !== 'string') throw new Error(`${file.name} is no longer stored.`);
    parts.push(got.value);
  }
  return parts.join('');
};

const MIME = {
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

// The file as the browser should save it. A table gets a byte-order mark, since
// Excel reads a CSV without one in the system's legacy encoding and every
// non-Latin form in it comes out as mojibake. The app's own table readers drop
// the mark.
export const blobOf = (name, text) => {
  const suffix = suffixOf(name);
  const marked = suffix === '.csv' || suffix === '.tsv' ? `\uFEFF${text}` : text;
  return new Blob([marked], { type: `${MIME[suffix] || 'text/plain'};charset=utf-8` });
};
