// What a recording's media type and its file extension are to each other.
//
// ONE TABLE, read both ways. The archive exporter needs an extension for a
// media type (the server's `mediaUrl` is a bare endpoint path with no
// filename, and a re-import validates the extension server-side), and the
// ELAN exporter needs a media type for a filename (MIME_TYPE is required on
// MEDIA_DESCRIPTOR). They held the same table twice, inverted, and had
// already drifted: only one of them knew the `audio/vnd.wave` the core serves
// for a .wav upload, and `audio/x-flac`.
//
// A type has one canonical extension and an extension one canonical type, so
// the table is written extension-first and the several types that mean one
// extension are listed as its aliases.
const TYPES = [
  ['wav', 'audio/x-wav', ['audio/wav', 'audio/wave', 'audio/vnd.wave']],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['ogg', 'audio/ogg'],
  ['flac', 'audio/flac', ['audio/x-flac']],
  ['weba', 'audio/webm'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['avi', 'video/x-msvideo'],
  ['mpg', 'video/mpeg'],
];

const TYPE_BY_EXT = new Map(TYPES.map(([ext, type]) => [ext, type]));
const EXT_BY_TYPE = new Map(
  TYPES.flatMap(([ext, type, aliases = []]) => [type, ...aliases].map((t) => [t, ext])),
);

/** A Content-Type header as the bare media type: no parameters, lowercased. */
export const bareMediaType = (contentType) =>
  String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

/**
 * The media type a file name says it holds, or `fallback` when the table does
 * not know the extension. ELAN re-detects the real type when it opens the
 * media, so what the exporter writes is a hint rather than a contract.
 */
export const mediaTypeForName = (name, fallback = 'audio/x-wav') => {
  const ext = String(name ?? '')
    .split('.')
    .pop()
    .toLowerCase();
  return TYPE_BY_EXT.get(ext) ?? fallback;
};

/**
 * The file extension (with its dot) for a Content-Type. A type the table does
 * not know falls back to its subtype without the `x-`/`vnd.` decoration, when
 * that reads like an extension, and to '' when it does not.
 */
export const extensionForMediaType = (contentType) => {
  const mime = bareMediaType(contentType);
  const known = EXT_BY_TYPE.get(mime);
  if (known) return `.${known}`;
  const subtype = (mime.split('/')[1] ?? '').replace(/^(x-|vnd\.)/, '');
  return /^[a-z0-9-]{1,8}$/.test(subtype) ? `.${subtype}` : '';
};
