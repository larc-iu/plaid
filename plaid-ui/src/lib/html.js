// Text written into HTML as character data or a quoted attribute value. The
// five characters HTML gives meaning to become entities, the ampersand first
// so the entities written for the rest are not escaped again. The one HTML
// escaper in Plaid: the igt leipzig.js copy format, ud's Grew highlighter and
// the Markdown fallback all write through it.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const htmlText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
