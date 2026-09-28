// The app's export of UMR documents IGT has added a sentence to, for
// test_umr_ancast_numbering.py to hold the AnCast writer's file to, byte for
// byte: the `# :: snt` numbers above all, which the app writes by position
// unless the document goes by its file's numbers (`fileNumbers` in
// src/domain/sentenceGraph.js).
//
// Each case is an imported file, changed as IGT changes it and not yet healed
// by opening it in the app, which is how a service reads it:
//   prepended  the released English corpus with a sentence typed in before
//              the first and split off (test/igtInsertSentence.js)
//   between    the same corpus with a sentence split off after the first
//   excerpt    a file numbered from snt5, with a sentence prepended
//   repeated   a file numbered from snt5 whose second sentence repeats 5
//   bom        a sentence text starting with U+FEFF (no Sentence line)
//   separator  a sentence text ending in U+001F (a Sentence line)
//
// Writes `[{name, raw, expected}]` to stdout, `raw` laid out as the Python
// client's `documents.get(id, include_body=True)` hands a document back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UMR = path.resolve(HERE, '..', '..');
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { insertSentenceAtStart } = await import(`${UMR}/test/igtInsertSentence.js`);

const LAYER_KEYS = {
  textLayers: 'text_layers',
  tokenLayers: 'token_layers',
  spanLayers: 'span_layers',
  relationLayers: 'relation_layers',
};
const toPython = (value) => {
  if (Array.isArray(value)) return value.map(toPython);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[LAYER_KEYS[key] ?? key] = key === 'metadata' || key === 'config' ? inner : toPython(inner);
  }
  return out;
};

const SEP = '#'.repeat(80);
// Index and Words only: the AnCast writer writes no gloss lines.
const block = (n, v = n) => `${SEP}
# :: snt${n}
Index: 1 2 3 4
Words: Ali kitap verdi .

# sentence level graph:
(s${v}v / ver-01
    :ARG0 (s${v}a / person
        :name (s${v}n / name :op1 "Ali"))
    :ARG1 (s${v}k / kitap))

# alignment:
s${v}v: 3-3
s${v}a: 1-1
s${v}n: 0-0
s${v}k: 2-2

# document level annotation:
(s${v}s0 / sentence
    :modal ((root :modal author)))
`;

const fromText = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));
const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);

// Text typed at the end of the first sentence and split off: every token
// after it moves along, and the new sentence records nothing.
function insertAfterFirst(raw) {
  const layer = raw.textLayers[0];
  const first = [...role(raw, 'sentence').tokens].sort((a, b) => a.begin - b.begin)[0];
  const at = first.end;
  const text = '\nYeni cümle .';
  const shift = [...text].length;
  const body = [...layer.text.body];
  layer.text.body = [...body.slice(0, at), ...text, ...body.slice(at)].join('');
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t.begin >= at && t !== first) {
        t.begin += shift;
        t.end += shift;
      }
    }),
  );
  role(raw, 'sentence').tokens.push({ id: 'igt-mid', begin: at + 1, end: at + shift });
  let from = at + 1;
  'Yeni cümle .'.split(' ').forEach((w, i) => {
    const len = [...w].length;
    role(raw, 'word').tokens.push({ id: `igt-m${i}`, begin: from, end: from + len });
    from += len + 1;
  });
}

// The first sentence's text with `before` put ahead of it and `after` behind
// its last word, inside the sentence's token: every other token moves along.
function withEdges(raw, before, after) {
  const layer = raw.textLayers[0];
  const sentence = [...role(raw, 'sentence').tokens].sort((a, b) => a.begin - b.begin)[0];
  const body = [...layer.text.body];
  let at = sentence.end;
  while (at > sentence.begin && /\s/.test(body[at - 1])) at -= 1;
  layer.text.body = [before, ...body.slice(0, at), after, ...body.slice(at)].join('');
  const b = [...before].length;
  const a = [...after].length;
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t === sentence) {
        t.end += b + a;
      } else {
        t.end += t.end > at ? b + a : b;
        t.begin += t.begin >= at ? b + a : b;
      }
    }),
  );
  return raw;
}

const ENGLISH = fs.readFileSync(
  path.join(UMR, 'test', 'fixtures', 'umr', 'english_umr-0001.umr'),
  'utf8',
);

const CASES = {
  prepended: () => {
    const raw = fromText(ENGLISH);
    insertSentenceAtStart(raw);
    return raw;
  },
  between: () => {
    const raw = fromText(ENGLISH);
    insertAfterFirst(raw);
    return raw;
  },
  excerpt: () => {
    const raw = fromText(`${block(5)}\n${block(6)}`);
    insertSentenceAtStart(raw);
    return raw;
  },
  repeated: () => fromText(`${block(5)}\n${block(5, 6)}\n${block(7)}`),
  // A sentence whose text starts with a byte-order mark, as a pasted text can.
  // JS counts U+FEFF as space and trims it, so the text is the Words line and
  // the app writes no Sentence line.
  bom: () => withEdges(fromText(block(1)), '\uFEFF', ''),
  // A text ending in U+001F, which Python counts as space and JS does not: the
  // app writes a Sentence line.
  separator: () => withEdges(fromText(block(1)), '', '\u001F'),
};

const out = Object.entries(CASES).map(([name, make]) => {
  const raw = make();
  // The document the export is taken from gets its own copy: the model may
  // keep references into what it was given.
  const expected = new UmrDocument({ raw: structuredClone(raw) }).toUmr();
  return { name, raw: toPython(raw), expected };
});
process.stdout.write(JSON.stringify(out));
