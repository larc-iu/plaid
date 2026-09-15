import { StarterKit } from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Markdown, MarkdownManager } from '@tiptap/markdown';

// The dialect a guideline is written in, in one place.
//
// A guideline is AUTHORED in a rich-text editor and READ through
// `lib/markdown.js` (marked, then DOMPurify). Those are two different programs
// over one string, so the set of things the editor can produce has to be a
// subset of the set of things the renderer keeps. Where it is not, the author
// sees one document and every reader sees another, silently: DOMPurify drops
// an unknown tag without a word.
//
// `markdown.js` says "the allowlist IS the dialect". This file is the other
// half of that sentence, and `guidelineMarkdown.test.js` checks the two agree
// rather than leaving it to whoever edits one of them next.
//
// UNDERLINE is the one thing StarterKit offers that is cut. Markdown has no
// underline, and the renderer's allowlist has no `u`, so an underlined word
// would round-trip to nothing at all.
//
// TABLES are in because the renderer already keeps them and people will paste
// them: a correspondence set or a paradigm arrives from a document or a
// spreadsheet as a table. Without the extension the parser has nowhere to put
// one and drops it WHOLE — the pasted table does not come out mangled, it
// comes out as an empty document — which is the worst of the available
// behaviours and is what `guidelineMarkdown.test.js` now holds shut.
export const GUIDELINE_EXTENSIONS = [
  StarterKit.configure({
    underline: false,
    // The editor is the document, not a page in a site: a link opens in a new
    // tab the same way the renderer's afterSanitizeAttributes hook makes it.
    link: { openOnClick: false },
  }),
  TableKit,
  Markdown,
];

// Parsing and serializing need no DOM and no editor instance, so they are
// plain functions rather than something only a mounted component can do. That
// is what lets the round-trip test be fast and exact.
const manager = new MarkdownManager({ extensions: GUIDELINE_EXTENSIONS });

/** Markdown to a Tiptap document. */
export const parseMarkdown = (markdown) => manager.parse(markdown ?? '');

/** A Tiptap document back to Markdown. */
export const serializeMarkdown = (doc) => manager.serialize(doc);

/**
 * `markdown -> markdown` through the editor's own document model.
 *
 * Exported for the tests, and worth having by name: it is the operation a
 * guideline actually undergoes every time someone opens it and saves it
 * without typing, and it is the one that has to be the identity.
 *
 * "The identity" for everything this editor WRITES. Markdown pasted in from
 * elsewhere may be normalized once (a table's columns are padded to an even
 * width, a literal `*` is escaped), and is then stable. Both are tested.
 */
export const roundTrip = (markdown) => serializeMarkdown(parseMarkdown(markdown));
