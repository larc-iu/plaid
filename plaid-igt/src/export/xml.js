// XML escaping for the .flextext, .eaf and LIFT exporters. The formats
// escape identically, and one copy keeps them from drifting.
//
// XML 1.0 has no escape for the C0 controls other than tab, newline and
// carriage return, nor for U+FFFE and U+FFFF, so those are dropped. One
// vertical tab from a Word paste would otherwise make the whole file one
// that ELAN and FLEx refuse to open. What is dropped is counted, so the
// export can name the document or lexicon it came from (countXmlDropped).
// eslint-disable-next-line no-control-regex -- matching these characters is the point
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
let xmlDropped = 0;

export const xmlEscape = (s) => {
  const raw = String(s ?? '');
  const kept = raw.replace(XML_FORBIDDEN, '');
  xmlDropped += raw.length - kept.length;
  return kept
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * Runs a synchronous serializer and says how many characters xmlEscape
 * dropped while it ran. Synchronous, so no other export can run in between.
 */
export function countXmlDropped(serialize) {
  const before = xmlDropped;
  const out = serialize();
  return { out, dropped: xmlDropped - before };
}
