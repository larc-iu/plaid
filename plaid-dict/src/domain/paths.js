// The reader's URLs. A headword's form is the page's name, so it is encoded
// rather than slugified: two entries spelled differently must never collide,
// and a form is not always ASCII.

export const dictionaryPath = (slug) => `/${encodeURIComponent(slug)}`;

export const formPath = (slug, form) => `/${encodeURIComponent(slug)}/${encodeURIComponent(form)}`;

/**
 * A dictionary's address as it is WRITTEN OUT, for someone to copy into a
 * message or an address bar. Routes live in the fragment (HashRouter), so the
 * `#` belongs to the address: printing the bare path told a lexicographer to
 * type something that lands back on the index. The base is `/dict/` in a
 * release build and `/` in development.
 */
export const dictionaryAddress = (slug) => `${import.meta.env.BASE_URL}#${dictionaryPath(slug)}`;
