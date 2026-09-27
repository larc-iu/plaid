// Reading an imported file as text. Every importer goes through here, so a
// file saved in the wrong encoding is caught once, before any of it is written.
//
// Windows tools ("Unicode text" in Excel, Notepad's "Unicode") save UTF-16.
// Such a file starts with a byte order mark, and is decoded as what it is.
// Without the mark, UTF-16 read as UTF-8 puts a NUL after every ASCII letter,
// which the server refuses deep into an import. A NUL in text is never
// wanted, so any NUL means the file is refused up front. So is a byte the
// encoding cannot hold: a Windows-1252 "café" from Excel would otherwise
// import as "caf" plus U+FFFD, with nothing on screen to say so (ruled
// 2026-09-27: refuse, never repair or guess another encoding).

export class NotUtf8FileError extends Error {
  constructor(name) {
    super(
      `${name ? `${name} is` : 'This file is'} not UTF-8. Save it as UTF-8 and import it again.`,
    );
    this.name = 'NotUtf8FileError';
  }
}

const encodingOf = (bytes) => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
};

/**
 * The text of a file's bytes: UTF-16 when a byte order mark says so, UTF-8
 * otherwise, with the mark dropped. Throws NotUtf8FileError, naming `name`
 * when given, for bytes that are not valid in the encoding and for text
 * holding a NUL.
 */
export function decodeText(bytes, name = null) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  try {
    text = new TextDecoder(encodingOf(view), { fatal: true }).decode(view);
  } catch (e) {
    if (e instanceof TypeError) throw new NotUtf8FileError(name);
    throw e;
  }
  if (text.includes('\u0000')) throw new NotUtf8FileError(name);
  return text;
}

/** A picked File (or Blob) read through decodeText. */
export const readTextFile = async (file, name = null) =>
  decodeText(new Uint8Array(await file.arrayBuffer()), name);
