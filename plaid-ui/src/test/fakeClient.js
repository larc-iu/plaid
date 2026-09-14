import { vi } from 'vitest';

// The client stubs more than one assistant test needs.
//
// The `@` typeahead reads one page of a project's documents, so every test that
// mounts the composer, the hook under it, or a whole surface has to answer that
// call or the list never opens. Three copies of the same two lines had already
// been written, and one of them was asserting the arguments.

/**
 * The `projects` calls the composer's `@` list makes. Spread into a larger fake
 * client's `projects` bundle where one is being built.
 */
export const documentsBundle = (documents = []) => ({
  listDocumentsPage: vi.fn().mockResolvedValue({ entries: documents }),
});

/** A client that answers the `@` list's one read, and nothing else. */
export const mentionsClient = (documents = []) => ({ projects: documentsBundle(documents) });
