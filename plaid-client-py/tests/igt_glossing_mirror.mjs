// plaid-igt's gloss, morph-type and zero-morph rules, run over the cases
// test_igt_glossing_mirror.py writes, so plaid_client.workflows.igt.glossing
// can be compared with them answer by answer.
//
// Reads a JSON file of cases as argv[2] and writes the answers to stdout.
// affixMarkers.js imports through the app's `@ui` alias, which is mapped here
// to plaid-ui's source as vite maps it.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI = resolve(ROOT, "plaid-ui/src");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@ui/")) {
      return next(pathToFileURL(resolve(UI, specifier.slice(4))).href, context);
    }
    return next(specifier, context);
  },
});

const DOMAIN = resolve(ROOT, "plaid-igt/src/domain");
const tagsets = await import(pathToFileURL(resolve(DOMAIN, "tagsets.js")).href);
const affixes = await import(
  pathToFileURL(resolve(DOMAIN, "affixMarkers.js")).href
);
const zero = await import(pathToFileURL(resolve(DOMAIN, "zeroMorph.js")).href);
const igtExport = await import(
  pathToFileURL(resolve(DOMAIN, "igtExport.js")).href
);

// One word's gloss line, each morpheme [gloss, morphType, form], read the two
// ways the app reads it. `tex`: the gb4e gloss line's parts with a letter,
// each true when left as a word and false when set in small caps. `cells`:
// each morpheme's cell checked by a mixed tagset that lists nothing, as the
// Analyze grid reads it, each non-empty part true when let through as a word.
const GLOSS_PART = /\\textsc\{([^}]*)\}|[\p{L}\p{M}\p{N}]+/gu;
const MIXED = { delimiters: ".:;\\-=~<>", mode: "mixed", values: [] };
const readLine = (line) => {
  const morphemes = line.map(([gloss, morphType, form]) => ({
    metadata: { form, morphType },
    annotations: { Gloss: { value: gloss } },
  }));
  const sentence = {
    annotations: {},
    tokens: [{ content: "w", annotations: {}, morphemes }],
  };
  const fields = { morphFields: ["Gloss"], wordFields: [], sentFields: [] };
  const glossLine = igtExport.formatGb4e(sentence, fields).split("\n")[3];
  const tex = [...glossLine.matchAll(GLOSS_PART)]
    .filter((m) => /\p{L}/u.test(m[1] ?? m[0]))
    .map((m) => m[1] === undefined);
  const word = line.map(([gloss, morphType, form]) => ({
    morphType,
    form,
    gloss,
  }));
  const cells = line.map(([gloss], i) => {
    const tagset = tagsets.readingTagset(
      MIXED,
      tagsets.morphemeGlossReading(word, i),
    );
    const refused = new Set(
      tagsets.validateValue(gloss, tagset).map((v) => v.begin),
    );
    return tagsets
      .scanValue(gloss, MIXED.delimiters)
      .filter((p) => p.text.trim())
      .map((p) => !refused.has(p.begin));
  });
  return { tex, cells };
};

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(
  JSON.stringify({
    abbreviations: [...tagsets.GLOSS_ABBREVIATIONS].sort(),
    morphemes: cases.values.map((v) => tagsets.glossMorphemes(v)),
    flags: cases.values.map((v) =>
      tagsets.lexicalFlags(tagsets.glossMorphemes(v)),
    ),
    // Values with no space, scanned as a tagset scans them on every
    // separator, the empty parts left out.
    scanned: cases.scanned.map((v) => {
      const parts = tagsets.scanValue(v, ".:;\\-=~<>");
      const flags = tagsets.lexicalFlagsOf(v, parts);
      return flags.filter((_, i) => parts[i].text.trim());
    }),
    units: cases.units.map((unit) => tagsets.lexicalFlags(unit)),
    parts: cases.parts.map((p) => tagsets.isLexicalPart(p)),
    bound: cases.morphTypes.map((t) => affixes.isBoundType(t)),
    zero: cases.forms.map((f) => zero.isZeroMorph(f)),
    names: cases.namers.map(([t, f]) => affixes.canNameWord(t, f)),
    lines: cases.lines.map(readLine),
  }),
);
