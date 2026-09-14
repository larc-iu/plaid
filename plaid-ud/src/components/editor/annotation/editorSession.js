import { createContext, useContext } from 'react';

// What the annotation grid reads that is the same for every sentence in the
// document: the write handlers, the project's controlled vocabularies and what
// their values mean, who is writing, which rows are showing, and the sentence's
// social and hand-off actions. One object, built once per document state by
// AnnotationEditor.
//
// It is a context rather than a prop because the readers are three deep (the
// row, the token column, the cell) and each of them wants the same handful.
// What stays a prop is what genuinely differs per row or per cell: the
// sentence, where it sits, its column widths, its focus handlers.
//
// Its value MUST be memoized on exactly what it holds. A document emits on
// every save, including the ones that change no data, and a session rebuilt on
// one of those would re-render every cell in the middle of an edit.
export const EditorSessionContext = createContext(null);

export const useEditorSession = () => {
  const session = useContext(EditorSessionContext);
  if (!session) {
    throw new Error('The annotation grid must be rendered inside an EditorSessionContext.Provider');
  }
  return session;
};

// The annotation fields a project can put a controlled vocabulary on. LEMMA is
// not one of them: a lemma is a word, not a tag out of a list.
//
// `vocab`, `validators` and `descriptions` are all keyed by field name, so a
// cell that read them by its own field alone was a picker exactly when the
// three maps happened to have no `lemma` key. That is the shape of today's
// data rather than a rule, and a `lemma` entry in any one of them would have
// turned the LEMMA cell into a combobox that refuses values off the list.
// Stating the set is the rule.
const CONTROLLED_FIELDS = Object.freeze(['upos', 'xpos', 'deprel', 'feats']);

const UNCONTROLLED = Object.freeze({
  suggestions: undefined,
  validate: undefined,
  descriptions: undefined,
});

/**
 * A field's controlled vocabulary, the rule that refuses a value outside it,
 * and the one-line definitions shown beside a value while picking one. All
 * three are absent together for a field nobody controls.
 */
export const controlledField = (session, field) =>
  CONTROLLED_FIELDS.includes(field)
    ? {
        suggestions: session?.vocab?.[field],
        validate: session?.validators?.[field],
        descriptions: session?.descriptions?.[field],
      }
    : UNCONTROLLED;
