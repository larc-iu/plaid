// The French catalog: every file in ./fr, each an object of English message to
// its translation. Split by area only so that two people can work at once.
// Loaded on demand, so an English session never downloads it.
const files = import.meta.glob('./fr/*.json', { eager: true, import: 'default' });
export default Object.assign({}, ...Object.values(files));
