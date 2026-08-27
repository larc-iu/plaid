import PlaidClient from '@larc-iu/plaid-client';
import { ROLES, stampInferred, confirmedInferred } from '@larc-iu/plaid-client';
import fs from 'node:fs';
const tok = fs.readFileSync('.token','utf8').trim();
const c = new PlaidClient('http://localhost:8085', tok);
// Resolve P-MAIN / "Edge cases" / LEX-A by name so the doc can be deleted and
// re-seeded (alpha-seed.mjs) without editing ids here.
const roleOf = (l) => l?.config?.plaid?.role;
const project = (await c.projects.list()).find((p) => p.name === 'P-MAIN');
const DOC = (await c.projects.listDocuments(project.id)).find((d) => d.name === 'Edge cases').id;
const LEXA = (await c.projects.get(project.id)).vocabs.find((v) => v.name === 'LEX-A').id;
const raw = await c.documents.get(DOC, true);
const tl = raw.textLayers.find(l => roleOf(l)===ROLES.BASELINE);
const cps=[...tl.text.body];
const wl = tl.tokenLayers.find(l=>roleOf(l)===ROLES.WORD), ml = tl.tokenLayers.find(l=>roleOf(l)===ROLES.MORPHEME);
const gloss = ml.spanLayers.find(s=>s.name==='Gloss'), pos = wl.spanLayers.find(s=>s.name==='Part of Speech');
const words = [...wl.tokens].sort((a,b)=>a.begin-b.begin).map(w=>({...w, content: cps.slice(w.begin,w.end).join(''), morphs: ml.tokens.filter(m=>m.begin===w.begin&&m.end===w.end).sort((a,b)=>(a.precedence??0)-(b.precedence??0))}));
const W = (t,i=0)=>words.filter(w=>w.content===t)[i];
const lex = await c.vocabLayers.get(LEXA, true);
const item = (f)=>lex.items.find(i=>i.form===f);
const out = {};
// ser#1: machine gloss w/ prob+detail; ser#2: verified gloss; "hola,": machine gloss (retype test)
out.ser1 = (await c.spans.create(gloss.id, [W('ser',0).morphs[0].id], 'MACH', stampInferred('service:test', {prob:0.42, detail:{alts:['a','b']}}))).id;
out.ser2 = (await c.spans.create(gloss.id, [W('ser',1).morphs[0].id], 'VER', confirmedInferred('service:test'))).id;
out.hola = (await c.spans.create(gloss.id, [W('"hola,"').morphs[0].id], 'HI', stampInferred('service:test'))).id;
// ngoko: machine POS on the word, machine segmentation ngo-ko, machine gloss on ko, machine link on ngo
const ng = W('ngoko');
out.ngPos = (await c.spans.create(pos.id, [ng.id], 'V', stampInferred('service:test'))).id;
await c.tokens.patchMetadata(ng.morphs[0].id, { form:'ngo', ...stampInferred('rule:analysis-precedent') });
const ko = await c.tokens.create(ml.id, tl.text.id, ng.begin, ng.end, 2, { form:'ko', ...stampInferred('rule:analysis-precedent') });
out.ko = ko.id;
out.koGloss = (await c.spans.create(gloss.id, [ko.id], 'PST', stampInferred('rule:analysis-precedent'))).id;
out.ngoLink = (await c.vocabLinks.create(item('the').id, [ng.morphs[0].id], stampInferred('rule:precedent-or-unique'))).id;
// machine word token: stamp the word `dog's`
await c.tokens.patchMetadata(W("dog's").id, stampInferred('service:punkt'));
out.dogs = W("dog's").id; out.ngoko = ng.id; out.ngo = ng.morphs[0].id;
console.log(JSON.stringify(out));
