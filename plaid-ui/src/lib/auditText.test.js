import { describe, it, expect } from 'vitest';
import { readableDescription, operationKindLabel } from './auditText.js';

// The audit log is immutable, so these descriptions are already stored with the
// id in them and the tidy-up has to happen at read time.
describe('readableDescription', () => {
  it('drops a trailing row id, whatever preposition introduces it', () => {
    expect(
      readableDescription(
        'Set editor config ud/dependency on layer 01a0971f-5cfd-703b-8865-7a91a69a411f',
      ),
    ).toBe('Set editor config ud/dependency');
    expect(
      readableDescription(
        'Create relation layer "Dependency Relations" in span layer 01a0971f-5c9f-7c48-853e-5ea994260810',
      ),
    ).toBe('Create relation layer "Dependency Relations"');
    expect(
      readableDescription(
        'Unset editor config igt/import on layer 01a0971f-5cfd-703b-8865-7a91a69a411f',
      ),
    ).toBe('Unset editor config igt/import');
  });

  it('leaves a description that names something a reader can see', () => {
    expect(readableDescription('Confirm word analysis')).toBe('Confirm word analysis');
    expect(readableDescription('Create and link vocab item')).toBe('Create and link vocab item');
    expect(readableDescription('Reconcile layers on open')).toBe('Reconcile layers on open');
    // A form that merely looks id-ish is not a UUID and stays.
    expect(readableDescription('Respell to 01a0971f')).toBe('Respell to 01a0971f');
  });

  it('passes anything that is not a string straight through', () => {
    expect(readableDescription(undefined)).toBe(undefined);
    expect(readableDescription(null)).toBe(null);
  });
});

describe('readableDescription, ids in the middle', () => {
  it('drops every id clause, not just one at the end', () => {
    // The longest line in a fresh project's feed, and three lines deep in the
    // history rail beside "Tokenize" and "Save baseline text".
    expect(
      readableDescription(
        'Create text in layer 01a09938-baf8-717f-92f9-51ab6040eb47 for document ' +
          '01a0993c-b129-7ce4-bc58-0b3512a0bb35 with 0 metadata keys',
      ),
    ).toBe('Create text with 0 metadata keys');
  });

  it('drops an id that follows the noun it names', () => {
    // History and Activity showed these beside "Create guideline "Clitic se"".
    expect(readableDescription('Update guideline 01a1cb73-0b1c-7a3e-9f00-1c2d3e4f5a6b')).toBe(
      'Update guideline',
    );
    expect(
      readableDescription(
        'Update document 01a1cb5c-0b1c-7a3e-9f00-1c2d3e4f5a6b name to "Field notes"',
      ),
    ).toBe('Update document name to "Field notes"');
  });

  it('still handles one at the end, and leaves the name in front of it', () => {
    expect(
      readableDescription(
        'Create document "NotesC" in project 01a09938-baba-736b-bca2-f1af827135b7',
      ),
    ).toBe('Create document "NotesC"');
  });
});

// Every description shape core writes (git grep ":description" in
// plaid-core/src/main), as History and Activity show it. Ids are dropped, and
// what is left says what happened: never a sentence that stops on "and",
// "into" or a preposition.
const ID = '019a2b3c-0b1c-7a3e-9f00-1c2d3e4f5a6b';
const ID2 = '019a2b3d-0b1c-7a3e-9f00-1c2d3e4f5a6c';
const ID3 = '019a2b3e-0b1c-7a3e-9f00-1c2d3e4f5a6d';
const ID4 = '019a2b3f-0b1c-7a3e-9f00-1c2d3e4f5a6e';
const TS = '2026-11-11T10:00:00Z';
const CORE_SHAPES = [
  // token.clj
  [`Create token 0-5 in layer ${ID}`, 'Create token 0-5'],
  [`Update start, end of token ${ID}`, 'Update start, end of token'],
  [`Update precedence of token ${ID}`, 'Update precedence of token'],
  [`Delete token ${ID}`, 'Delete token'],
  [`Create 3 tokens in layer ${ID}`, 'Create 3 tokens'],
  [`Create 1 token in layer ${ID}`, 'Create 1 token'],
  ['Delete 3 tokens', 'Delete 3 tokens'],
  ['Update 2 tokens', 'Update 2 tokens'],
  [`Split token ${ID} at position 3`, 'Split token at position 3'],
  [`Merge tokens ${ID} and ${ID2}`, 'Merge tokens'],
  [`Shift boundary of token ${ID}`, 'Shift boundary of token'],
  // span.clj
  [`Create span ${ID} with 2 tokens in layer ${ID2}`, 'Create span with 2 tokens'],
  [`Create span ${ID} with 1 token in layer ${ID2}`, 'Create span with 1 token'],
  [`Update attributes of span ${ID}`, 'Update attributes of span'],
  [`Delete span ${ID} and its 2 relations`, 'Delete span and its 2 relations'],
  [`Delete span ${ID} and its 1 relations`, 'Delete span and its 1 relation'],
  [`Delete span ${ID} and its 0 relations`, 'Delete span and its 0 relations'],
  [`Create 4 spans in layer ${ID}`, 'Create 4 spans'],
  ['Delete 2 spans', 'Delete 2 spans'],
  [`Update tokens of span ${ID} to 3 tokens`, 'Update tokens of span to 3 tokens'],
  // relation.clj
  [`Create relation ${ID} from span ${ID2} to span ${ID3} in layer ${ID4}`, 'Create relation'],
  [`Update attributes of relation ${ID}`, 'Update attributes of relation'],
  [`Delete relation ${ID}`, 'Delete relation'],
  [`Create 2 relations in layer ${ID}`, 'Create 2 relations'],
  ['Delete 2 relations', 'Delete 2 relations'],
  [`Update source of relation ${ID} to span ${ID2}`, 'Update source of relation'],
  [`Update target of relation ${ID} to span ${ID2}`, 'Update target of relation'],
  // text.clj
  [
    `Create text in layer ${ID} for document ${ID2} with 2 metadata keys`,
    'Create text with 2 metadata keys',
  ],
  [`Create text in layer ${ID} for document ${ID2}`, 'Create text'],
  [`Update body of text ${ID}`, 'Update body of text'],
  [`Edit body of text ${ID}`, 'Edit body of text'],
  [
    'Made a token over the whole text on "Tokens", "Sentences"',
    'Made a token over the whole text on "Tokens", "Sentences"',
  ],
  [`Delete text ${ID}`, 'Delete text'],
  // layers (layer.clj and each layer kind)
  [`Create text layer "Text" in project ${ID}`, 'Create text layer "Text"'],
  [`Create token layer "Words" in text layer ${ID}`, 'Create token layer "Words"'],
  [`Create span layer "Gloss" in token layer ${ID}`, 'Create span layer "Gloss"'],
  [
    `Create relation layer "Dependency Relations" in span layer ${ID}`,
    'Create relation layer "Dependency Relations"',
  ],
  [`Update token layer ${ID}`, 'Update token layer'],
  [`Shift span layer ${ID} up`, 'Shift span layer up'],
  [`Shift relation layer ${ID} down`, 'Shift relation layer down'],
  [`Delete text layer ${ID}`, 'Delete text layer'],
  [`Set ud constraints on token layer ${ID}`, 'Set ud constraints'],
  [`Remove ud constraints from span layer ${ID}`, 'Remove ud constraints'],
  [`Repair layer rules on relation layer ${ID}`, 'Repair layer rules'],
  ['Applied layer rules', 'Applied layer rules'],
  // metadata.clj, on every kind of row
  [`Set metadata on token ${ID} with 2 keys`, 'Set metadata with 2 keys'],
  [`Set metadata on document ${ID} with 1 keys`, 'Set metadata with 1 key'],
  [`Patch metadata on span ${ID} with 3 ops`, 'Patch metadata with 3 ops'],
  [`Patch metadata on vocab item ${ID} with 1 ops`, 'Patch metadata with 1 op'],
  [`Delete all metadata from relation ${ID}`, 'Delete all metadata'],
  // document.clj, document_names.clj, media.clj, restore.clj
  [`Create document "Notes" in project ${ID}`, 'Create document "Notes"'],
  [
    `Create document "Notes" in project ${ID} with 2 metadata keys`,
    'Create document "Notes" with 2 metadata keys',
  ],
  [
    `Create document "Notes" in project ${ID} with 1 metadata keys`,
    'Create document "Notes" with 1 metadata key',
  ],
  [`Update document ${ID} name to "Field notes"`, 'Update document name to "Field notes"'],
  [`Update document ${ID}`, 'Update document'],
  ['Copy "Notes" as "Notes 2"', 'Copy "Notes" as "Notes 2"'],
  [`Delete document ${ID}`, 'Delete document'],
  [
    'Rename document "a" to "a 2": another document of the project had the same name',
    'Rename document "a" to "a 2": another document of the project had the same name',
  ],
  [`Upload media file "talk.wav" to document ${ID}`, 'Upload media file "talk.wav"'],
  [`Delete media file of document ${ID}`, 'Delete media file of document'],
  [`Restore document to ${TS}`, `Restore document to ${TS}`],
  // project.clj
  ['Create project "Kukama"', 'Create project "Kukama"'],
  [`Update project ${ID} to name "Kukama 2"`, 'Update project to name "Kukama 2"'],
  [`Update project ${ID}`, 'Update project'],
  [`Delete project "Kukama" (${ID})`, 'Delete project "Kukama"'],
  [`Delete project ${ID}`, 'Delete project'],
  [`Add maintainer ann@example.org to project ${ID}`, 'Add maintainer ann@example.org'],
  [`Remove writer ben@example.org from project ${ID}`, 'Remove writer ben@example.org'],
  [`Set editor config ud/dependency on layer ${ID}`, 'Set editor config ud/dependency'],
  [`Unset editor config igt/import on layer ${ID}`, 'Unset editor config igt/import'],
  // A project borrows a vocabulary, and a borrowing ends (by that project's
  // maintainer or the home's), in the borrowing project's Activity.
  [`Add vocab ${ID} to project ${ID2}`, 'Add vocab'],
  [`Remove vocab ${ID} from project ${ID2}`, 'Remove vocab'],
  // guideline.clj
  ['Create guideline "Clitic se"', 'Create guideline "Clitic se"'],
  [`Update guideline ${ID}`, 'Update guideline'],
  [`Delete guideline ${ID}`, 'Delete guideline'],
  // vocab_layer.clj and vocab_home.clj, since the vocabulary home (05a54a802):
  // listed in the home project's Activity. The name is quoted as typed.
  ['Create vocabulary “Lexicon”', 'Create vocabulary “Lexicon”'],
  ['Rename vocabulary “Lexicon” to “Lexicon 2”', 'Rename vocabulary “Lexicon” to “Lexicon 2”'],
  ['Update vocabulary “Lexicon”', 'Update vocabulary “Lexicon”'],
  ['Delete vocabulary “Lexicon”', 'Delete vocabulary “Lexicon”'],
  [`Delete vocabulary ${ID}`, 'Delete vocabulary'],
  [
    'Move vocabulary “Lexicon” to project “Kukama”',
    'Move vocabulary “Lexicon” to project “Kukama”',
  ],
  [
    'Vocabulary “Lexicon” belongs to project “Kukama”',
    'Vocabulary “Lexicon” belongs to project “Kukama”',
  ],
  // Before the vocabulary home, still in a vocabulary's History.
  ["Create vocab 'Lexicon'", "Create vocab 'Lexicon'"],
  [`Update vocab ${ID} name to "Lexicon 2"`, 'Update vocab name to "Lexicon 2"'],
  [`Update vocab ${ID}`, 'Update vocab'],
  [`Delete vocab ${ID}`, 'Delete vocab'],
  [`Add maintainer ann@example.org to vocab ${ID}`, 'Add maintainer ann@example.org'],
  [`Remove maintainer ann@example.org from vocab ${ID}`, 'Remove maintainer ann@example.org'],
  // vocab_item.clj, vocab_link.clj, vocab_restore.clj
  ["Create vocab item 'kai'", "Create vocab item 'kai'"],
  [`Update vocab item ${ID}`, 'Update vocab item'],
  [`Delete vocab item ${ID}`, 'Delete vocab item'],
  ['Create 3 vocab items', 'Create 3 vocab items'],
  ['Update 2 vocab items', 'Update 2 vocab items'],
  ['Delete 1 vocab item', 'Delete 1 vocab item'],
  [`Merge 3 vocab items into ${ID}`, 'Merge 3 vocab items'],
  [`Merge 1 vocab items into ${ID}`, 'Merge 1 vocab item'],
  [`Restore vocab item ${ID} to ${TS}`, `Restore vocab item to ${TS}`],
  [`Create vocab mapping ${ID} with 2 metadata keys`, 'Create vocab mapping with 2 metadata keys'],
  [`Create vocab mapping ${ID}`, 'Create vocab mapping'],
  ['Create 2 vocab mappings', 'Create 2 vocab mappings'],
  ['Delete vocab mapping', 'Delete vocab mapping'],
  ['Delete 2 vocab mappings', 'Delete 2 vocab mappings'],
  // users, tokens, invites, auth
  ['Create user ann@example.org', 'Create user ann@example.org'],
  ['Update user ann@example.org', 'Update user ann@example.org'],
  ['Set profile picture for user ann@example.org', 'Set profile picture for user ann@example.org'],
  [
    'Remove profile picture for user ann@example.org',
    'Remove profile picture for user ann@example.org',
  ],
  ['Deactivate user ann@example.org', 'Deactivate user ann@example.org'],
  ['Reactivate user ann@example.org', 'Reactivate user ann@example.org'],
  ['Logout user ann@example.org', 'Logout user ann@example.org'],
  [
    'Create API token "script" for user ann@example.org',
    'Create API token "script" for user ann@example.org',
  ],
  [`Revoke API token ${ID}`, 'Revoke API token'],
  ['Create invite', 'Create invite'],
  [
    'Create password reset link for user ann@example.org',
    'Create password reset link for user ann@example.org',
  ],
  ['Revoke invite', 'Revoke invite'],
  [
    'Password reset via invite for user ann@example.org',
    'Password reset via invite for user ann@example.org',
  ],
  [
    'Add user ann@example.org to project via invite',
    'Add user ann@example.org to project via invite',
  ],
];

describe('readableDescription, every shape core writes', () => {
  it.each(CORE_SHAPES)('%s', (stored, shown) => {
    expect(readableDescription(stored)).toBe(shown);
  });

  it('leaves no id and no sentence that stops on a joining word', () => {
    const dangling = /\b(?:and|into|or|of|on|in|to|from|for|with|at|as|by|via)$/i;
    for (const [stored] of CORE_SHAPES) {
      const shown = readableDescription(stored);
      expect(shown, stored).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(shown, stored).not.toMatch(dangling);
      expect(shown, stored).not.toMatch(/\s{2}|\(\s*\)/);
    }
  });
});

// A name the user typed is shown whole, whatever it holds: core writes it
// between quotes as typed, with no escaping, so a quote inside it is a bare
// quote too. "Create document "Pear story in Manipuri" in project <id>" read
// "Create document "Pear story" (REV-PB-C-4).
const NAMES = [
  'Notes on verbs',
  'Trip to Imphal',
  'Story for kids',
  'Pear story in Manipuri',
  'Songs from Ukhrul',
  'Pear_Story_02 Gopendro',
  'COMPLETE:Pear story in Meitei',
  'Tones on nouns (draft)',
  'Verbs and nouns',
  'Merged into one',
  'Uses of ka',
  `Copy of ${ID}`,
  `Notes on ${ID}`,
  'The "pear" story in Manipuri',
  "Ukhrul's songs for kids",
  'Story (1 keys)',
];
const NAMED_SHAPES = [
  [(n) => `Create document "${n}" in project ${ID}`, (n) => `Create document "${n}"`],
  [
    (n) => `Create document "${n}" in project ${ID} with 2 metadata keys`,
    (n) => `Create document "${n}" with 2 metadata keys`,
  ],
  [
    (n) => `Create document "${n}" in project ${ID} with 1 metadata keys`,
    (n) => `Create document "${n}" with 1 metadata key`,
  ],
  [(n) => `Create text layer "${n}" in project ${ID}`, (n) => `Create text layer "${n}"`],
  [(n) => `Create token layer "${n}" in text layer ${ID}`, (n) => `Create token layer "${n}"`],
  [(n) => `Create span layer "${n}" in token layer ${ID}`, (n) => `Create span layer "${n}"`],
  [
    (n) => `Create relation layer "${n}" in span layer ${ID}`,
    (n) => `Create relation layer "${n}"`,
  ],
  [(n) => `Delete project "${n}" (${ID})`, (n) => `Delete project "${n}"`],
  [(n) => `Upload media file "${n}.wav" to document ${ID}`, (n) => `Upload media file "${n}.wav"`],
  [(n) => `Upload media file "${n}" to document ${ID}`, (n) => `Upload media file "${n}"`],
  [(n) => `Update document ${ID} name to "${n}"`, (n) => `Update document name to "${n}"`],
  [(n) => `Update project ${ID} to name "${n}"`, (n) => `Update project to name "${n}"`],
  [(n) => `Update vocab ${ID} name to "${n}"`, (n) => `Update vocab name to "${n}"`],
  [(n) => `Copy "${n}" as "${n} 2"`, (n) => `Copy "${n}" as "${n} 2"`],
  [
    (n) => `Rename document "${n}" to "${n} 2": another document of the project had the same name`,
    (n) => `Rename document "${n}" to "${n} 2": another document of the project had the same name`,
  ],
  [
    (n) => `Create API token "${n}" for user ann@example.org`,
    (n) => `Create API token "${n}" for user ann@example.org`,
  ],
  [(n) => `Create project "${n}"`, (n) => `Create project "${n}"`],
  [(n) => `Create guideline "${n}"`, (n) => `Create guideline "${n}"`],
  [(n) => `Create vocab '${n}'`, (n) => `Create vocab '${n}'`],
  [(n) => `Create vocabulary \u201c${n}\u201d`, (n) => `Create vocabulary \u201c${n}\u201d`],
  [
    (n) => `Rename vocabulary \u201c${n}\u201d to \u201c${n} 2\u201d`,
    (n) => `Rename vocabulary \u201c${n}\u201d to \u201c${n} 2\u201d`,
  ],
  [(n) => `Delete vocabulary \u201c${n}\u201d`, (n) => `Delete vocabulary \u201c${n}\u201d`],
  [
    (n) => `Move vocabulary \u201c${n}\u201d to project \u201c${n} 2\u201d`,
    (n) => `Move vocabulary \u201c${n}\u201d to project \u201c${n} 2\u201d`,
  ],
  [
    (n) => `Vocabulary \u201c${n}\u201d belongs to project \u201c${n} 2\u201d`,
    (n) => `Vocabulary \u201c${n}\u201d belongs to project \u201c${n} 2\u201d`,
  ],
  [(n) => `Create vocab item '${n}'`, (n) => `Create vocab item '${n}'`],
  [
    (n) => `Restore to ${TS} (after \u201c${n}\u201d)`,
    (n) => `Restore to ${TS} (after \u201c${n}\u201d)`,
  ],
];

describe('readableDescription, a name is kept whole', () => {
  const rows = NAMED_SHAPES.flatMap(([stored, shown]) => NAMES.map((n) => [stored(n), shown(n)]));
  it.each(rows)('%s', (stored, shown) => {
    expect(readableDescription(stored)).toBe(shown);
  });

  it('still drops the ids around a name, and an apostrophe outside one is not a quote', () => {
    expect(readableDescription(`Add maintainer o'brien@example.org to project ${ID}`)).toBe(
      "Add maintainer o'brien@example.org",
    );
    expect(readableDescription(`Set metadata on document ${ID} with 1 keys`)).toBe(
      'Set metadata with 1 key',
    );
  });
});

// An operation's kind, in the words its History row shows.
describe('operationKindLabel', () => {
  it('names every kind the server accepts', () => {
    expect(
      [
        'assistant-plan',
        'service-run',
        'import',
        'bulk-edit',
        'guess-adoption',
        'repair',
        'review',
      ].map(operationKindLabel),
    ).toEqual(['Assistant', 'Automatic', 'Import', 'Bulk edit', 'Guess taken', 'Repair', 'Review']);
  });

  it('names nothing for an operation with no kind', () => {
    expect(operationKindLabel(undefined)).toBe(null);
    expect(operationKindLabel(null)).toBe(null);
  });
});
