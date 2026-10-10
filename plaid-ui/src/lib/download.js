// Files and text the browser hands the reader: a file name safe on every
// system, a blob saved as a download, and text put on the clipboard.
//
// No static imports: plain node loads this file (igt's runExport, in the
// fidelity runs), and the toast library is the apps' dependency, not this
// package's. copyText reaches notify.js when it has something to say.

/**
 * `name` as a file name every system takes (no extension handling): the
 * characters a path or a zip entry may not hold, and control characters, made
 * spaces, runs of space made one, dots trimmed from either end, and at most
 * 120 code points. `untitled` when nothing is left.
 */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  // Cap by code points so the cut can't strand half a surrogate pair.
  const capped = [...cleaned].slice(0, 120).join('').trim();
  return capped === '' ? 'untitled' : capped;
}

/**
 * `blob` saved as the download `name`. The link is in the page while it is
 * clicked, which Firefox needs, and the blob's URL is let go a second later,
 * once the download has it.
 */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * `text` put on the clipboard. Answers whether it was. On a non-secure origin
 * `navigator.clipboard` is undefined, and a denied permission rejects: either
 * way `failure` is said, with the title `title`.
 */
export async function copyText(text, failure, title = 'Failed to copy') {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const { notifyError } = await import('./notify.js');
    notifyError(failure, title);
    return false;
  }
}
