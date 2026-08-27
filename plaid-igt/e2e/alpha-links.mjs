// Alpha-plan helper: link surgery by id (used by TEST_PLAN.md run 2).
//   node e2e/_links.mjs clear <docId>                 delete every vocab link in the doc
//   node e2e/_links.mjs relink <docId> <tokenIdSuffix> <itemId>   replace a token's link (human)
//   node e2e/_links.mjs rename <itemId> <newForm>
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';
const client = new PlaidClient('http://localhost:8085', readToken().token);
const [cmd, ...args] = process.argv.slice(2);
const docLinks = async (docId) => {
  const raw = await client.documents.get(docId, true);
  const out = [];
  for (const tl of raw.textLayers[0].tokenLayers)
    for (const v of tl.vocabs || [])
      for (const l of v.vocabLinks || []) out.push({ ...l, vocabName: v.name });
  return out;
};
if (cmd === 'clear') {
  const links = await docLinks(args[0]);
  for (const l of links) await client.vocabLinks.delete(l.id);
  console.log('deleted', links.length);
} else if (cmd === 'relink') {
  const [docId, suffix, itemId] = args;
  const links = await docLinks(docId);
  const prior = links.filter((l) => l.tokens.some((t) => t.endsWith(suffix)));
  for (const l of prior) await client.vocabLinks.delete(l.id);
  const raw = await client.documents.get(docId, true);
  const tok = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.tokens)
    .find((t) => t.id.endsWith(suffix));
  const r = await client.vocabLinks.create(itemId, [tok.id]);
  console.log('relinked', tok.id, '->', itemId, 'removed', prior.length, r);
} else if (cmd === 'rename') {
  const r = await client.vocabItems.update(args[0], args[1]);
  console.log('renamed', r);
}
