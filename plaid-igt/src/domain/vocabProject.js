// Which project an assistant conversation about a vocabulary belongs to.
//
// A vocabulary is its own resource at /vocabularies/:id and several projects
// may link the same one, while the assistant is per project: the service
// registers on a project, discovery is per project, and a conversation's record
// is keyed by it. So the project is resolved backwards, from the projects that
// link this vocabulary.
//
// Exactly one linking project is the answer. Several is NOT resolved to one by
// guessing: filing the thread under a project the user did not choose would put
// it in an Assistant tab they were never on, so the pane is not offered at all
// (Luke, 2026-09-12).

/** The single project linking `vocabularyId`, or null when none or several do. */
export const soleProjectLinking = (projects, vocabularyId) => {
  if (!vocabularyId) return null;
  const linking = (projects || []).filter((p) =>
    (p?.vocabs || []).some((v) => v?.id === vocabularyId),
  );
  return linking.length === 1 ? linking[0].id : null;
};
