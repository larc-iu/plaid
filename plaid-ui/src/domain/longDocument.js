// A document past this many words is slow to edit in the browser (Luke,
// 2026-10-02: no engineering for documents of 20,000 words and more, a notice
// to split them instead). The editors that slow down with size show
// LongDocumentNotice above this count.
export const LONG_DOCUMENT_WORDS = 15000;

/** Whether a document of `words` words gets the notice. */
export const isLongDocument = (words) => Number.isFinite(words) && words > LONG_DOCUMENT_WORDS;
