// A FLEx backup's recordings, chosen alongside it, matched to its texts.

import { matchMediaFiles } from '../elan/buildDocuments.js';

/**
 * Which picked recording belongs to which chosen text, by the file name FLEx
 * recorded for it (the ELAN importer's matching: the exact name, then the
 * same name with another extension). Texts cut from one session share its
 * recording, so a file goes to every text that names it. One over the
 * server's limit is matched to nothing, so a smaller copy can take its place.
 */
export function matchRecordings({ documents, selected, mediaFiles, maxBytes }) {
  const wanted = documents.filter((d) => d.mediaName && selected.has(d.guid));
  const entries = wanted.map((d) => ({ fileName: d.guid, media: [{ relativeUrl: d.mediaName }] }));
  const fits = (f) => maxBytes == null || !(f.size > maxBytes);
  const fit = matchMediaFiles(entries, mediaFiles.filter(fits), { shared: true });
  const over = matchMediaFiles(
    entries.filter((e) => !fit.byFile.has(e.fileName)),
    mediaFiles.filter((f) => !fits(f)),
    { shared: true },
  );
  return {
    wanted,
    byFile: fit.byFile,
    missing: over.missing,
    tooLarge: [...new Set(over.byFile.values())],
    unmatched: [...fit.unmatched, ...over.unmatched],
    maxBytes,
  };
}
