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
