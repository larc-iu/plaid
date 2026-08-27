// Alpha-plan helper: create + whitespace-tokenize a document.
import PlaidClient from '@larc-iu/plaid-client';
import { ROLES } from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';
const client = new PlaidClient('http://localhost:8085', readToken().token);
const [pid, name, text] = process.argv.slice(2);
const roleOf = (l) => l?.config?.plaid?.role;
const cpLen = (s) => [...s].length;
const project = await client.projects.get(pid);
const tl = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
const find = (r) => tl.tokenLayers.find((l) => roleOf(l) === r);
const doc = await client.documents.create(pid, name);
const t = await client.texts.create(tl.id, doc.id, text);
const body = text;
const sents = [];
let cp = 0;
const lines = body.split('\n');
lines.forEach((line, i) => {
  const len = cpLen(line);
  const end = i === lines.length - 1 ? cp + len : cp + len + 1;
  sents.push({ begin: cp, end });
  cp = end;
});
await client.tokens.bulkCreate(
  sents.map((s) => ({ tokenLayerId: find(ROLES.SENTENCE).id, text: t.id, ...s })),
);
const words = [];
const re = /\S+/g;
let m;
while ((m = re.exec(body)) !== null) {
  const begin = cpLen(body.slice(0, m.index));
  words.push({ begin, end: begin + cpLen(m[0]) });
}
await client.tokens.bulkCreate(
  words.map((w) => ({ tokenLayerId: find(ROLES.WORD).id, text: t.id, ...w })),
);
await client.tokens.bulkCreate(
  words.map((w) => ({ tokenLayerId: find(ROLES.MORPHEME).id, text: t.id, ...w, precedence: 1 })),
);
console.log(doc.id);
