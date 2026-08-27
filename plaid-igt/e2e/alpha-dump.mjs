// Alpha-plan helper: dump a document as words / morphemes / links (code-point offsets).
//   nvm use 24.1.0 && node e2e/alpha-dump.mjs <docId>
import PlaidClient from '@larc-iu/plaid-client';
import { readToken } from './fixtures.js';
const client = new PlaidClient('http://localhost:8085', readToken().token);
const raw = await client.documents.get(process.argv[2], true);
const text = [...raw.textLayers[0].text.body];
const cp = (b, e) => text.slice(b, e).join('');
const tls = raw.textLayers[0].tokenLayers;
const roleOf = (tl) => tl.config?.plaid?.role;
const wordTl = tls.find((t) => roleOf(t) === 'word');
const morphTl = tls.find((t) => roleOf(t) === 'morpheme');
const sentTl = tls.find((t) => roleOf(t) === 'sentence');
const linksByTok = new Map();
for (const tl of tls)
  for (const v of tl.vocabs || []) {
    for (const l of v.vocabLinks || [])
      for (const t of l.tokens) {
        if (!linksByTok.has(t)) linksByTok.set(t, []);
        const st = l.metadata?.prov ? (l.metadata.provConfirmed ? '(verified)' : '(machine)') : '';
        linksByTok.get(t).push(`${v.name}:${l.vocabItem?.form}${st}`);
      }
  }
const show = (t) =>
  `${JSON.stringify(cp(t.begin, t.end))}[${t.begin},${t.end}]${t.metadata && Object.keys(t.metadata).length ? ' meta=' + JSON.stringify(t.metadata) : ''}${linksByTok.has(t.id) ? '  LINKS=' + linksByTok.get(t.id).join(',') : ''}`;
for (const w of [...wordTl.tokens].sort((a, b) => a.begin - b.begin)) {
  console.log('W', show(w), w.id.slice(-12));
  for (const m of [...morphTl.tokens]
    .filter((m) => m.begin >= w.begin && m.end <= w.end)
    .sort((a, b) => a.begin - b.begin))
    console.log('   m', show(m), m.id.slice(-12));
}
console.log(
  'sentences',
  sentTl?.tokens.map((s) => [s.begin, s.end]).join(' '),
  '| links total',
  [...linksByTok.values()].flat().length,
);
