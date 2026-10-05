// What an ELAN Add documents run did, in one line: the result panel and the
// toast both say it, so they never disagree.
const many = (n, one, more) => (n === 1 ? one : `${n} ${more}`);

/** "1 added, 2 kept, 1 replaced, a recording added to an existing document." */
export function elanTally(results) {
  const parts = [`${results.imported - results.redone} added`];
  if (results.copied)
    parts.push(`${results.copied} added as ${results.copied === 1 ? 'a copy' : 'copies'}`);
  if (results.skipped) parts.push(`${results.skipped} kept`);
  if (results.redone) parts.push(`${results.redone} replaced`);
  if (results.recordingsAdded) {
    parts.push(
      `${many(results.recordingsAdded, 'a recording', 'recordings')} added to ${
        results.recordingsAdded === 1 ? 'an existing document' : 'existing documents'
      }`,
    );
  }
  if (results.recordingsUnused) {
    parts.push(`${many(results.recordingsUnused, 'a recording', 'recordings')} not used`);
  }
  return `${parts.join(', ')}.`;
}
