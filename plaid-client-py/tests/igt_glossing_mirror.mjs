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
  }),
);
