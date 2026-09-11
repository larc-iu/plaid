// What a comment is attached to, said in words — the app-agnostic half.
//
// A comment carries only `(entityType, entityId)`. That is enough for the
// surface it sits on, and useless in a Comments tab, which would otherwise be a
// list of uuids. Each app walks its own document and builds
// `entityId -> descriptor`; these two turn a descriptor into words and decide
// whether the thing it named is still there.
//
// The same words are the CAPTION a comment is posted with, because a comment
// OUTLIVES its anchor: when the word it was about is merged, re-segmented or
// retyped away, the comment stays and the caption is what it has left to show.
// `describeAnchor` marks such a comment outdated.
//
// A descriptor is `{ label, scope?, order? }`: `label` is what to show, `scope`
// an optional kind for styling, `order` a position for text-order sorting.
//
// Framework-agnostic, like everything else under domain/.

// The heading for an anchor that no longer exists, by what it was. Every entity
// type either app anchors a comment to has an entry: a UD sentence and an IGT
// word are both `token`, and both read "Deleted word" here, which is what the
// substrate calls them whatever the app does.
const GONE = {
  document: 'This document',
  text: 'Baseline text',
  token: 'Deleted word',
  span: 'Deleted annotation',
  relation: 'Deleted relation',
  'vocab-item': 'Deleted entry',
};

export function describeAnchor(index, entityType, entityId, anchorLabel = null) {
  const found = index.get(entityId);
  if (found) return found;
  const caption = String(anchorLabel ?? '').trim();
  return {
    kind: 'outdated',
    outdated: true,
    label: caption || GONE[entityType] || 'Deleted',
    detail: '',
    sentenceIndex: null,
    sentenceId: null,
    jumpId: null,
  };
}

/**
 * The caption to post a comment with: the descriptor's words, so an outdated
 * comment later reads the way its thread heading did. A sentence, the
 * document, and the text are their own label; anything inside a sentence
 * says where it sat.
 */
export function anchorCaption(descriptor) {
  if (!descriptor) return null;
  const { kind, label, detail } = descriptor;
  const place = ['word', 'morpheme', 'annotation', 'entry'].includes(kind) && detail;
  return place ? `${label}, ${detail}` : label || null;
}
