// The zip and unzip an app hands ProjectImportExportPage (its `format.zip` and
// `format.unzip`), over JSZip, for an app whose files are text. JSZip is the
// app's own dependency (an optional peer of this package), so only an app
// that imports this module needs it.
import JSZip from 'jszip';

/** The files, `[{ path, text }]`, as one zip's Blob. */
export const zip = (files) => {
  const archive = new JSZip();
  for (const f of files) archive.file(f.path, f.text);
  return archive.generateAsync({ type: 'blob' });
};

/** A zip's files as `[{ path, bytes }]`, folders left out. */
export const unzip = async (file) => {
  const archive = await JSZip.loadAsync(file);
  const entries = Object.values(archive.files).filter((e) => !e.dir);
  return Promise.all(
    entries.map(async (e) => ({ path: e.name, bytes: await e.async('uint8array') })),
  );
};
