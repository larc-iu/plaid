// What IGT does to a document when a sentence is typed in before the first
// one: the text grows at the start, every token after it moves, and the new
// sentence and its words store nothing of UMR's. For tests over a raw
// document. Not a test file itself, so the runner does not pick it up.
const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);

export function insertSentenceAtStart(raw, text = 'Yeni cümle .') {
  const layer = raw.textLayers[0];
  const length = [...text].length;
  const shift = length + 1;
  layer.text.body = `${text}\n${layer.text.body}`;
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      t.begin += shift;
      t.end += shift;
    }),
  );
  role(raw, 'sentence').tokens.unshift({ id: 'igt-s', begin: 0, end: length });
  let at = 0;
  text.split(' ').forEach((w, i) => {
    const len = [...w].length;
    role(raw, 'word').tokens.push({ id: `igt-w${i}`, begin: at, end: at + len });
    at += len + 1;
  });
}
