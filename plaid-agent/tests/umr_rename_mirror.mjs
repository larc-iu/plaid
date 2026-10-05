// plaid-umr's own reading of a variable typed over in Text mode
// (`UmrDocument._renameIn`, what `planPenman` reads as a rename), so
// test_umr_rename_mirror.py can hold the assistant's `_rename_in` to it: a
// rename when exactly one variable goes and one arrives and they are plainly
// the same node, otherwise none.
//
// Over every sentence of the released samples whose nodes all hang from one
// root (the assistant's text is the root's graph), and the same samples with
// a `:quote` edge from a root to itself and from one of its children to
// itself, each text is:
//   one        one node's variable typed over everywhere it appears
//   concept    the root's variable and its concept typed over (no rename)
//   two        two variables typed over at once (no rename)
//
// Writes `[{name, raw, cases: [{sentence, text, rename}]}]` to stdout,
// `rename` being `[from, to]` or null, `raw` laid out as the Python client's
// `documents.get(id, include_body=True)` hands a document back.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UMR = resolve(HERE, "../../plaid-umr");
const { parseUmrFile } = await import(`${UMR}/src/domain/format/umrFile.js`);
const { planImport } = await import(`${UMR}/src/domain/umrImport.js`);
const { UmrDocument } = await import(`${UMR}/src/domain/UmrDocument.js`);
const { rawFromPlan } = await import(`${UMR}/test/rawFromPlan.js`);
const { parsePenman } = await import(`${UMR}/src/domain/format/penman.js`);

const LAYER_KEYS = {
  textLayers: "text_layers",
  tokenLayers: "token_layers",
  spanLayers: "span_layers",
  relationLayers: "relation_layers",
};
const toPython = (value) => {
  if (Array.isArray(value)) return value.map(toPython);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[LAYER_KEYS[key] ?? key] =
      key === "metadata" || key === "config" ? inner : toPython(inner);
  }
  return out;
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A variable typed over everywhere it stands as one: after an opening
// bracket or a space, before a space or a closing bracket.
const retype = (text, from, to) =>
  text.replace(new RegExp(`(?<=[\\s(])${escape(from)}(?=[\\s)])`, "gu"), to);
// A new variable for `v`, one the whole document does not use.
let taken = new Set();
const fresh = (v) => {
  let to = `${v}9`;
  while (taken.has(to)) to = `${to}9`;
  return to;
};

const concepts = (raw) =>
  raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes).spanLayers[0];

// A `:quote` edge from the first root that has a child to itself, and from
// that child to itself.
function withSelfLoops(raw) {
  const doc = new UmrDocument({ raw: structuredClone(raw) });
  const s = doc.graph.sentences.find(
    (x) => x.roots.length === 1 && x.roots[0].out.length,
  );
  if (!s) return false;
  const root = s.roots[0];
  const child = doc.graph.nodesById.get(root.out[0].target);
  const relations = concepts(raw).relationLayers.find(
    (l) => l.config?.umr?.relations,
  );
  [root, child].forEach((n, i) => {
    relations.relations.push({
      id: `self-${i}`,
      source: n.id,
      target: n.id,
      value: ":quote",
      metadata: { umr: { order: 1000 } },
    });
  });
  return true;
}

function casesOf(raw) {
  const doc = new UmrDocument({ raw: structuredClone(raw) });
  taken = new Set([...doc.graph.nodesById.values()].map((n) => n.var));
  const out = [];
  // What planPenman reads as the rename, before it checks the rest.
  const plan = (sentence, text) => {
    const s = doc.sentence(sentence);
    const parsed = parsePenman(text, { several: true });
    if (parsed.errors.length)
      throw new Error(`${text}: ${parsed.errors[0].message}`);
    const r = doc._renameIn(s, parsed, new Set(s.nodes.map((n) => n.id)));
    out.push({ sentence, text, rename: r ? [r.from, r.to] : null });
  };
  doc.graph.sentences.forEach((s) => {
    if (s.roots.length !== 1) return;
    const text = doc.penmanOf(s.index);
    s.nodes.forEach((n) => plan(s.index, retype(text, n.var, fresh(n.var))));
    const root = s.roots[0];
    plan(
      s.index,
      retype(text, root.var, fresh(root.var)).replace(
        `(${fresh(root.var)} / ${root.concept}`,
        `(${fresh(root.var)} / ${root.concept}-x`,
      ),
    );
    if (s.nodes.length > 1) {
      const [a, b] = s.nodes;
      const toA = fresh(a.var);
      taken.add(toA);
      plan(s.index, retype(retype(text, a.var, toA), b.var, fresh(b.var)));
    }
  });
  return out;
}

const out = [];
const dir = `${UMR}/test/fixtures/umr`;
for (const f of fs
  .readdirSync(dir)
  .filter((x) => x.endsWith(".umr"))
  .sort()) {
  const text = fs.readFileSync(`${dir}/${f}`, "utf8");
  const raw = rawFromPlan(planImport(parseUmrFile(text).sentences, []));
  out.push({ name: f, raw: toPython(raw), cases: casesOf(raw) });
  if (withSelfLoops(raw)) {
    out.push({
      name: `${f} self-loops`,
      raw: toPython(raw),
      cases: casesOf(raw),
    });
  }
}
process.stdout.write(JSON.stringify(out));
