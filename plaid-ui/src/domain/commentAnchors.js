// What a comment is attached to, said in words: the app-agnostic half.
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
// An app that shows only some of a document's layers can name the ids the
// document still holds (`documentEntityIds`). A thread on one of those that the
// app's index lacks is on a layer the app does not show, not outdated, and
// `describeAnchor` says so (`elsewhere`).
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

// The heading for an anchor that is still there, on a layer this app does not
// show, when the comment carries no caption of its own.
const ELSEWHERE = {
  document: 'This document',
  text: 'Baseline text',
  token: 'Word',
  span: 'Annotation',
  relation: 'Relation',
};

// The keys under which a document read holds the entities a comment can be on.
const ENTITY_LISTS = new Set(['tokens', 'spans', 'relations']);

/**
 * Every id in a document read that a comment can be anchored to: the document,
 * its texts, and the tokens, spans and relations of every layer at any depth.
 * Layer ids, config and metadata are not entities and are left out.
 */
export function documentEntityIds(raw) {
  const ids = new Set();
  if (!raw || typeof raw !== 'object') return ids;
  if (raw.id) ids.add(raw.id);
  const walk = (layer) => {
    if (!layer || typeof layer !== 'object') return;
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'text' && value?.id) ids.add(value.id);
      else if (ENTITY_LISTS.has(key) && Array.isArray(value)) {
        for (const entity of value) if (entity?.id) ids.add(entity.id);
      } else if (key.endsWith('Layers') && Array.isArray(value)) value.forEach(walk);
    }
  };
  walk(raw);
  return ids;
}

export function describeAnchor(index, entityType, entityId, anchorLabel = null, present = null) {
  const found = index.get(entityId);
  if (found) return found;
  const caption = String(anchorLabel ?? '').trim();
  if (present?.has(entityId)) {
    return {
      kind: 'elsewhere',
      elsewhere: true,
      label: caption || ELSEWHERE[entityType] || 'Annotation',
      detail: '',
      sentenceIndex: null,
      sentenceId: null,
      jumpId: null,
    };
  }
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
