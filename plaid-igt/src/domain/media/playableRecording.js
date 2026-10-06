// Readying a chosen recording for upload: what the browser cannot play is
// either made playable or refused, before a byte goes up.
//
// Every path that uploads a recording passes it through here when it is
// chosen: the Media tab, and each importer's recordings. A WAV is decided by
// its `fmt ` chunk (wavAdpcm.js): PCM, 32-bit float, A-law and mu-law go as
// they are, IMA and MS ADPCM and 64-bit float are decoded to a 16-bit PCM WAV
// of the same rate and channels (the same length, so no time in the document
// moves), and any other coding is refused by name. Anything else is asked of a media element.

import { adpcmWavToPcm, readWavInfo, wavCodingName, wavVerdict } from './wavAdpcm.js';
import { bareMediaType, mediaTypeForName } from './mediaTypes.js';

const PROBE_TIMEOUT_MS = 5000;

const fileReader = (file) => async (from, to) =>
  new Uint8Array(await file.slice(from, Math.min(to, file.size)).arrayBuffer());

/**
 * Whether this browser can play `file`. `canPlayType` first, which answers at
 * once for the common types. It answers "" for some files browsers do play (a
 * QuickTime .mov in Chrome), so a "" is checked by loading the file into a
 * media element: an error that it cannot be decoded is a no, metadata is a
 * yes, and silence until the timeout is a yes, since nothing proved otherwise.
 * Outside a browser everything is playable.
 */
async function browserCanPlay(file, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return true;
  const type = bareMediaType(file.type) || mediaTypeForName(file.name, '');
  const el = document.createElement(type.startsWith('video/') ? 'video' : 'audio');
  if (type && el.canPlayType(type) !== '') return true;
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs);
      const done = (answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
      el.addEventListener('loadedmetadata', () => done(true), { once: true });
      el.addEventListener(
        'error',
        () => {
          const code = el.error?.code;
          // 3: cannot be decoded. 4: no decoder for the format.
          done(!(code === 3 || code === 4));
        },
        { once: true },
      );
      el.preload = 'metadata';
      el.muted = true;
      el.src = url;
    });
  } finally {
    el.removeAttribute('src');
    el.load?.();
    URL.revokeObjectURL(url);
  }
}

/**
 * `file` (a File or Blob with a name) ready to upload:
 *   `{ file, convertedFrom: null }`   — it plays as it is
 *   `{ file, convertedFrom: 'IMA ADPCM' }` — a new PCM WAV of the same name
 *   `{ refused: '<message naming the file>' }`
 *
 * `canPlay` decides a file that is not a WAV (browserCanPlay unless given).
 */
export async function prepareRecording(file, { canPlay = browserCanPlay } = {}) {
  const name = file.name || 'recording';
  const info = await readWavInfo(fileReader(file), file.size).catch(() => null);
  if (info) {
    const verdict = wavVerdict(info);
    if (verdict === 'play') return { file, convertedFrom: null };
    if (verdict === 'convert') {
      // A file that cannot be read, or too large to decode in this tab's
      // memory, is refused like one that cannot be decoded at all, so the
      // person is told instead of the choice coming to nothing.
      try {
        const pcm = adpcmWavToPcm(info, new Uint8Array(await file.arrayBuffer()));
        return {
          file: new File([pcm], name, { type: 'audio/wav', lastModified: file.lastModified }),
          convertedFrom: wavCodingName(info.tag, info.bitsPerSample),
        };
      } catch (error) {
        console.error('Converting a recording failed:', error);
        return { refused: `${name} could not be converted to PCM WAV.` };
      }
    }
    return {
      refused: `${name} cannot be played in a browser (${wavCodingName(info.tag, info.bitsPerSample)} WAV).`,
    };
  }
  if (await canPlay(file)) return { file, convertedFrom: null };
  return { refused: `${name} cannot be played in this browser.` };
}

/**
 * Ready several chosen recordings at once: `{ files, converted, refused }`,
 * `files` in the order given with each converted one in place of its original
 * and the refused ones left out, `converted` as `[{ name, from }]` and
 * `refused` as messages.
 */
export async function prepareRecordings(files, options) {
  const out = { files: [], converted: [], refused: [] };
  for (const file of files) {
    const ready = await prepareRecording(file, options);
    if (ready.refused) {
      out.refused.push(ready.refused);
    } else {
      out.files.push(ready.file);
      if (ready.convertedFrom) out.converted.push({ name: file.name, from: ready.convertedFrom });
    }
  }
  return out;
}

/** The one line that says what was converted, or null when nothing was. */
export function convertedNote(converted) {
  if (!converted.length) return null;
  if (converted.length === 1) {
    return `Converted ${converted[0].name} from ${converted[0].from} to PCM WAV.`;
  }
  return `Converted ${converted.length} recordings to PCM WAV.`;
}
