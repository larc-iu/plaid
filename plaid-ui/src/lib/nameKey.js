// A name as an app compares it with a stored one: composed (NFC), the way the
// server stores every name. A file name from macOS spells `é` as `e` and a
// combining accent, so a document, vocabulary or import stamp made from it is
// stored in the other spelling and a plain `===` never finds it again.
// Dependency-free, so a module the plain node suites load can import it by
// its real path.

/** `name` composed, as the server stores it. */
export const nameKey = (name) => String(name ?? '').normalize('NFC');

/** Whether two names are the same name, whatever their Unicode spelling. */
export const sameName = (a, b) => nameKey(a) === nameKey(b);
