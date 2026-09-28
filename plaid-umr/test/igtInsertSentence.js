// What IGT does to a document when a sentence is typed in before the first
// one, as measured against core: the text grows at the start and the first
// sentence token, which begins there, absorbs it. Splitting the new text off
// keeps the ORIGINAL token, its id and its metadata, on the left, which is
// the new text, and makes a new token with no metadata for the old sentence.
// Every other token moves along. The new text's words store nothing of
// UMR's. For tests over a raw document. Not a test file itself, so the
// runner does not pick it up.
const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);

export function insertSentenceAtStart(raw, text = 'Yeni cümle .') {
  const layer = raw.textLayers[0];
  const length = [...text].length;
  const shift = length + 1;
  layer.text.body = `${text}\n${layer.text.body}`;
  const sentences = role(raw, 'sentence');
  const first = [...sentences.tokens].sort((a, b) => a.begin - b.begin)[0];
  const firstEnd = first.end;
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t === first) return;
      t.begin += shift;
      t.end += shift;
    }),
  );
  first.begin = 0;
  first.end = length;
  sentences.tokens.push({ id: 'igt-right', begin: shift, end: firstEnd + shift });
  let at = 0;
  text.split(' ').forEach((w, i) => {
    const len = [...w].length;
    role(raw, 'word').tokens.push({ id: `igt-w${i}`, begin: at, end: at + len });
    at += len + 1;
  });
  return first.id;
}
