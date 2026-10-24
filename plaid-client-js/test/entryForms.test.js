// Lexicon entry forms are stored without affix or clitic markers (R27).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MORPH_TYPES,
  entryForm,
  readAffixMarkers,
  decorateWithAffixMarkers,
} from "../src/index.js";

test("a form carrying its type's markers loses them", () => {
  assert.deepEqual(entryForm("suffix", "-s"), { form: "s", morphType: "suffix" });
  assert.deepEqual(entryForm("prefix", "ka-"), { form: "ka", morphType: "prefix" });
  assert.deepEqual(entryForm("bound root", "*pa"), { form: "pa", morphType: "bound root" });
  assert.deepEqual(entryForm("infixing interfix", "-um-"), {
    form: "um",
    morphType: "infixing interfix",
  });
  for (const type of MORPH_TYPES) {
    assert.deepEqual(entryForm(type, decorateWithAffixMarkers(type, "ka")), {
      form: "ka",
      morphType: type,
    });
  }
});

test("dash and equals markers set the type, whatever type came with the form", () => {
  assert.deepEqual(entryForm(null, "-s"), { form: "s", morphType: "suffix" });
  assert.deepEqual(entryForm(undefined, "ni="), { form: "ni", morphType: "proclitic" });
  assert.deepEqual(entryForm("stem", "-s"), { form: "s", morphType: "suffix" });
  assert.deepEqual(entryForm("suffix", "=ni"), { form: "ni", morphType: "enclitic" });
  assert.deepEqual(entryForm("clitic", "=ni"), { form: "ni", morphType: "enclitic" });
  assert.deepEqual(entryForm(null, "-um-"), { form: "um", morphType: "infix" });
});

test("any other form is kept as written with the type it came with", () => {
  assert.deepEqual(entryForm(null, "perro"), { form: "perro", morphType: null });
  assert.deepEqual(entryForm("stem", "perro"), { form: "perro", morphType: "stem" });
  assert.deepEqual(entryForm(null, "*kwa"), { form: "*kwa", morphType: null });
  assert.deepEqual(entryForm(null, "a-b"), { form: "a-b", morphType: null });
  assert.deepEqual(entryForm(null, "=a-"), { form: "=a-", morphType: null });
  assert.deepEqual(entryForm("suffix", "-"), { form: "-", morphType: "suffix" });
  assert.deepEqual(entryForm(null, ""), { form: "", morphType: null });
  assert.deepEqual(entryForm("Martian", "x"), { form: "x", morphType: "Martian" });
  assert.deepEqual(entryForm("Suffix", "-s"), { form: "s", morphType: "Suffix" });
});

test("readAffixMarkers reads a morph back as FieldWorks spells it", () => {
  assert.deepEqual(readAffixMarkers("stem", "-ar"), { form: "-ar", morphType: "stem" });
  assert.deepEqual(readAffixMarkers("Martian", "-ar"), { form: "ar", morphType: "suffix" });
  assert.deepEqual(readAffixMarkers(null, "*kwa"), { form: "*kwa", morphType: null });
});
