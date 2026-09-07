// The reader's URLs. A headword's form is the page's name, so it is encoded
// rather than slugified: two entries spelled differently must never collide,
// and a form is not always ASCII.

export const dictionaryPath = (slug) => `/${encodeURIComponent(slug)}`;

export const formPath = (slug, form) => `/${encodeURIComponent(slug)}/${encodeURIComponent(form)}`;
