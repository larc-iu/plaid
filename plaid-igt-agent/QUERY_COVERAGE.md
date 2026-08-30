# What linguists ask, and what the assistant can do about it

162 realistic queries collected from the FLEx / Toolbox / ELAN communities,
field-methods course materials, the glossing literature, archive deposit
guides, and recent IGT-tooling papers (sources at the end), scored against
the assistant's tools as of 2026-08-29.

Verdicts:

- **direct**: one tool answers it (plus the model's write-up).
- **chain**: the model can do it by combining tools and reasoning; works, but
  may be slow or shaky on big corpora.
- **gap**: needs a new tool; the data is there.
- **out**: outside the data model or a deliberate ruling (no export tool, no
  undo, no raw query language for now).

Tools today: `project_overview`, `read_document`, `search` (patterns,
`missing=true`), `field_values`, `read_lexicon`, `lexicon_entry`,
`concordance`, `analyses_of`, `check_consistency`, `recent_changes`,
`plan_status`; plan ops `set_field`, `set_analysis`, `set_orthography`,
`respell`, `link_entry`, `unlink_entry`, `create_entry`, `set_entry_field`,
`set_document_metadata`, `create_document`.

> Since this was scored (same day): every "gap" below except export was built, `search(missing)` was folded into `worklist`, `field_values` into `frequency_list`, and a read-only `query` escape hatch was added.

## Scorecard

Roughly: 32 direct, 74 chain, 40 gap, 16 out.

### A. Morphology and syntax questions

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 1 | Suffixes on verb stems and their order | chain | `concordance` per suffix + `analyses_of` (position in word) |
| 2 | Every word with -ka and its glosses | direct | `concordance` / `analyses_of` |
| 3 | Plural on inanimate nouns? | chain | `concordance` PL, model judges animacy from glosses |
| 4 | Verbs with applicative, transitive? | chain | `concordance` on the gloss, read contexts |
| 5 | Clauses with subject after verb | gap | needs a sequence search over gloss/POS |
| 6 | Paradigm table for "go" | chain | `concordance` on the gloss, model assembles |
| 7 | -taa vs -ta | chain | two concordances |
| 8 | Morphemes occurring once | gap | `corpus_stats` (hapax) |
| 9 | Allomorphs of NEG and environments | chain | `concordance` where=Gloss |
| 10 | Every form glossed DU | direct | `search` (regex `^DU$`) |
| 11 | Relative clauses, ten examples | chain | reading; a sequence search would help |
| 12 | Possessor + possessum constructions | chain | as 11 |
| 13 | Clauses with two overt arguments | gap | sequence search |
| 14 | Words with more than four morphemes | gap | `corpus_stats` |
| 15 | Noun classes and agreement prefixes | chain | `concordance` by gloss/POS |
| 16 | Particle "na" grouped by function | direct | `concordance` baseline + model |
| 17 | Morphemes only in narratives | gap | stats by document metadata (genre) |
| 18 | Reduplication | direct | `search` regex on baseline |
| 19 | Switch-reference evidence | chain | concordance + reading |
| 20 | Two speakers' perfective | chain | per-document concordance; overview should list document metadata |
| 21 | Frequent verb roots and frames | gap | frequency list |
| 22 | Candidate compounds | chain | reading, or concordance by POS |
| 23 | Idiom-like multiword glosses | direct | `search` regex `\s` where=Gloss |

### B. Corpus statistics

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 24 | Words, sentences, texts | gap | `corpus_stats` (per-document headers exist in `read_document`, no total) |
| 25 | Distinct wordforms, how many analysed | gap | `corpus_stats` |
| 26 | % tokens with complete analysis | gap | `corpus_stats` |
| 27 | Top 200 wordforms | gap | frequency list |
| 28 | Most frequent morphemes with dispersion | gap | frequency list |
| 29 | Count of "nimba" and which texts | direct | `concordance` (document tags) |
| 30 | Entries never used in a text | gap | `check_lexicon` |
| 31 | Type-token ratio per text | gap | `corpus_stats` |
| 32 | Texts with most unglossed words | gap | `corpus_stats` (`search missing` lists but per-document % is manual) |
| 33 | Sentences with no translation | direct | `search missing=true where=Translation` |
| 34 | Material added this month | chain | `recent_changes` needs a `since` filter |
| 35 | Gloss inventory for the abbreviations list | direct | `field_values` |
| 36 | POS values and counts | direct | `field_values` |
| 37 | Sentence length by genre | gap | stats by metadata |
| 38 | Texts where half the words are hapax | gap | `corpus_stats` |
| 39 | Speaker contributions in minutes | out | media durations not exposed (speaker counts: metadata) |
| 40 | Confirmed by hand vs accepted from model | gap | provenance filter |

### C. Consistency and quality control

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 41 | Morphemes glossed several ways | direct | `check_consistency` |
| 42 | PL vs PLU | direct | `field_values` + `concordance` |
| 43 | Check against Leipzig list | chain | `field_values` + model knowledge |
| 44 | Lowercase grammatical glosses | direct | `search` regex where=Gloss |
| 45 | Morphemes not adding up to the baseline | gap | `check_integrity` |
| 46 | Gloss count ≠ morpheme count | direct | `search missing=true` on the morpheme field (same thing in this data model) |
| 47 | POS values used once | direct | `field_values` |
| 48 | Same gloss, different entries | gap | `check_lexicon` |
| 49 | Links whose entry form no longer matches | gap | `check_lexicon` |
| 50 | Missing / copied translations | direct + chain | `search missing`; copy detection by reading |
| 51 | "3 SG" with a space | direct | `search` regex |
| 52 | Same gloss on two different morphemes | gap | add the reverse direction to `check_consistency` |
| 53 | Normalize "to eat" / "eat" | chain | `concordance` → `set_field` per ref; bulk replace would be one call |
| 54 | Boundaries splitting a digraph | gap | `check_integrity` |
| 55 | Duplicate sentences | gap | `check_integrity` |
| 56 | Field filled on some words only | chain | `search missing` per document |
| 57 | Rank worst disagreements | direct | `check_consistency` (sorted by count) |
| 58 | Characters outside the orthography | gap | character inventory |
| 59 | Combining vs precomposed | gap | character inventory |
| 60 | Model output nobody confirmed | gap | provenance filter |
| 61 | Spellings the lexicon does not know | gap | `worklist` (unlinked by frequency) |
| 62 | Empty sentence fields project-wide | direct | `field_values` (empty count) / `search missing` |

### D. Lexicon management

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 63 | Unlinked wordforms by frequency | gap | `worklist` |
| 64 | Create entries for top unlinked morphemes | chain | worklist + `create_entry` + `link_entry` |
| 65 | Homographs and how they differ | chain | `read_lexicon`; `check_lexicon` would list them |
| 66 | Merge two entries | gap | `merge_entries` plan op (Bulk Edit tab has the logic) |
| 67 | Split senses and relink | chain | entries are per sense here: `create_entry` + `link_entry` |
| 68 | Entries with no POS | chain | `read_lexicon` scan; `check_lexicon` |
| 69 | Entries with no example | gap | `check_lexicon` (examples come from `lexicon_entry`) |
| 70 | Transitive example of "kwaana" | direct | `lexicon_entry` / `concordance` |
| 71 | No gloss in second language | chain | `read_lexicon` scan |
| 72 | Affix entries without morph type | chain | `read_lexicon` scan |
| 73 | Add allomorph and relink | out + direct | no allomorph entries (precedent-based by ruling); relinking is `link_entry` |
| 74 | Find an allomorph I entered | direct | `read_lexicon` pattern |
| 75 | One entry or two? | chain | advice + `concordance` |
| 76 | Entries attested in one text | gap | `check_lexicon` |
| 77 | Lexicon gloss ≠ corpus gloss | gap | `check_lexicon` |
| 78 | Assign semantic domains | out | not a field unless the project adds one (then `set_entry_field`) |
| 79 | Coverage by semantic domain | out | as 78 |
| 80 | Forms differing by one vowel | chain | `read_lexicon` + model; `check_lexicon` near-duplicates |
| 81 | POS in lexicon never in texts | chain | `field_values` vs `read_lexicon` |
| 82 | Reversal index | chain | `read_lexicon` sorted by the model |
| 83 | Impact before deleting an entry | direct + gap | `lexicon_entry` link counts; `delete_entry` plan op |
| 84 | Untouched since FLEx import | chain | provenance hidden; `recent_changes` coarse |
| 85 | Never checked with a speaker | out | no review-status field |

### E. Glossing and segmentation

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 86 | Gloss the next unglossed sentence | chain | `search missing` + `analyses_of` + `set_analysis` (core loop) |
| 87 | Segment and gloss all remaining words | chain | as 86, many refs |
| 88 | Three morphemes, not two | direct | `set_analysis` |
| 89 | Apply this analysis everywhere | chain | `concordance` refs + `set_analysis` each; `set_analysis_for_form` would be one call |
| 90 | "house" vs "village", fix the rest | chain | `concordance` + `set_field` |
| 91 | Unparsed words by frequency | gap | `worklist` |
| 92 | Suggest a gloss for -ri | direct | `concordance` + model |
| 93 | Treat =n as a clitic everywhere | chain | `set_analysis` per occurrence with type; bulk op would help |
| 94 | Split at the equals sign | direct | `set_analysis` |
| 95 | Zero morpheme | chain | `set_analysis` with form "∅" |
| 96 | Gloss all but proper names | chain | |
| 97 | Mark code-switched words | chain | a note field if configured |
| 98 | Approve fifty guesses one by one | out | plans are approved whole (UI) |
| 99 | Top three alternative glosses with counts | direct | `analyses_of` |
| 100 | Redo this sentence | direct | `set_analysis` |
| 101 | Copy analysis to identical sentence | chain | `set_analysis` per word |
| 102 | Word gloss line convention | chain | `field_values` + `set_field` |
| 103 | Add a phonetic line from the baseline | chain | `set_orthography` per word; a bulk copy op would help |

### F. Bulk edits and orthography

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 104 | Replace ï with ɨ in all baselines, keep analyses | gap | `respell_all` (whole-token replace keeps tokens) |
| 105 | ng → ŋ except across boundaries | gap | as 104 with a condition |
| 106 | Respell everywhere and the headword | chain + gap | `respell` per word; `rename_entry` missing |
| 107 | Normalize apostrophes | gap | `respell_all` |
| 108 | POS = v for words with a TAM suffix | chain | `concordance` → `set_field` |
| 109 | Period at end of every definition | chain | `read_lexicon` + `set_entry_field` |
| 110 | NEG → NEG1 / NEG2 by position | chain | `concordance` → `set_field` |
| 111 | 3sg → 3SG project-wide | chain | `concordance` → `set_field`; `replace_in_field` would be one call |
| 112 | Capitalize translations, add punctuation | chain | `search` + `set_field` |
| 113 | Strip trailing whitespace | chain | as 112 |
| 114 | Copy baseline into phonetic tier | gap | bulk copy to orthography |
| 115 | Set Note on selected words | chain | no UI selection; refs by description |
| 116 | Preview before running | direct | every plan is a preview |
| 117 | Undo the last bulk edit | out | ruling; note: applied `set_span` ops carry the prior value, so an "invert this plan" button is possible later |
| 118 | Regex over definitions | chain | `read_lexicon` + `set_entry_field` |
| 119 | Delete blank-but-present values | chain | `search` + `set_field ""` |

### G. Documents and metadata

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 120 | Create document with speaker, date, genre | direct | `create_document` |
| 121 | Texts missing a speaker | chain | `read_document` per doc; overview should list metadata |
| 122 | Genre on five documents | direct | `set_document_metadata` |
| 123 | Table of texts with metadata and counts | gap | overview with metadata + `corpus_stats` |
| 124 | Recordings without transcription | out | media not exposed |
| 125 | Rename a document | gap | `rename_document` plan op |
| 126 | Split a long document | out | |
| 127 | Tag as paradigm | direct | `set_document_metadata` |
| 128 | Access note | chain | a metadata field if configured |
| 129 | Same speaker, one session | chain | metadata |
| 130 | Import ELAN | out | the import UI does this |

### H. Teaching and field methods

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 131 | TAM markers we have, gaps to target | chain | `field_values` + `concordance` |
| 132 | Sentences with unconfirmed phonemes | chain | `search` regex |
| 133 | Minimal pairs /t/ /tʰ/ | chain | needs the wordform list (frequency list) |
| 134 | Wordlist so far | gap | frequency list |
| 135 | Summarize last week's session on NP order | chain | `recent_changes` + reading |
| 136 | Draft an elicitation protocol | chain | |
| 137 | Five plural examples formatted | direct | `concordance` + formatting |
| 138 | Explain possession from our texts | chain | |
| 139 | Quiz me on our abbreviations | direct | `field_values` |
| 140 | My errors this week | chain | `recent_changes` + `check_consistency` |
| 141 | Beginner lesson from the corpus | chain | |
| 142 | Flashcards from top 50 nouns | gap | frequency list |
| 143 | Are my cited examples current | chain | `search` |
| 144 | Show me this corpus's conventions | direct | `project_overview` + `field_values` + `check_consistency` |

### I. Export and reporting

145 to 154: **out** by ruling (no export tool yet). 150 (four-line plain text) and 154 (morpheme/gloss/count CSV) are near-misses: `read_document` and `field_values` output is close enough that the model can reformat small amounts by hand.

### J. History and provenance

| # | Query | Verdict | How / what is missing |
|---|---|---|---|
| 155 | Who changed this gloss and when | chain | `recent_changes(document)` is per operation, not per entity |
| 156 | Text before yesterday's bulk edit | out | no time travel (ruling) |
| 157 | Everything my assistant changed last week | chain | `recent_changes` needs `since` / `user` filters |
| 158 | Model vs person annotations | gap | provenance filter |
| 159 | Revert to before the import | out | ruling |
| 160 | When did CAUS become APPL | chain | operation messages only |
| 161 | Lexicon edits since the snapshot | chain | `recent_changes(since)` |
| 162 | Has anyone touched my finished texts | chain | `recent_changes(document)` |

## Gaps, ranked by queries unlocked per unit of work

1. **`corpus_stats`** (totals, per-document and per-metadata-value breakdowns: sentences, words, distinct forms, % analysed / glossed / translated / linked, hapax, type-token ratio, longest words) and a **frequency list** (wordforms or morphemes with counts and document dispersion). Unlocks ~16 (8, 14, 17, 21, 24–28, 31, 32, 37, 38, 123, 133, 134, 142). Everything is already in the loaded documents. Small.
2. **`check_lexicon`**: unattested entries, missing POS / gloss / examples, homographs, near-duplicate forms, lexicon gloss vs corpus gloss, links whose form no longer matches, one gloss linked to several entries. Unlocks ~12 (30, 48, 49, 65, 68, 69, 71, 72, 76, 77, 80, 81). Small to medium.
3. **`worklist(kind, group_by_form)`**: unlinked / unglossed / unanalysed items grouped by form, by frequency, the FLEx "Word Analyses" view. Unlocks ~7 and speeds the core glossing loop (61, 63, 64, 87, 91, 32). Small.
4. **Bulk plan ops** mirroring the Bulk Edit tab: `replace_in_field(field, pattern, replacement, regex)`, `respell_all(pattern, replacement)`, `copy_baseline_to_orthography`, `set_analysis_for_form`. Unlocks ~14 and turns many "chain" verdicts into one call (53, 89, 93, 102–107, 110–114, 119). Medium.
5. **Provenance**: `search(provenance=machine|unverified|human)` or a `review_queue`. Unlocks 40, 60, 158 (+84, 85 partly). The prov metadata is already parsed. Small.
6. **`check_integrity`**: segmentation vs surface, digraph splits, duplicate sentences, character inventory with NFC/NFD detection. Unlocks 45, 54, 55, 58, 59. Small.
7. **Lexicon plan ops**: `merge_entries`, `delete_entry`, `rename_entry`. Unlocks 66, 83, 106. Small (merge logic exists in the Bulk Edit tab).
8. **Cheap filters**: `recent_changes(since, user)`; document metadata columns in `project_overview`. Unlocks 34, 121, 157, 161, 20. Tiny.
9. **Sequence search** over gloss / POS sequences within a sentence ("V followed by N", "word glossed X anywhere before word glossed Y"). Unlocks ~8 syntax-flavoured questions (1, 5, 11–13, 15, 19, 22). Medium; this is the point at which a raw query tool starts to pay for itself.
10. **Document plan ops**: `rename_document`; splitting is harder. 125, 126.

Out of scope for now, by ruling or data model: export (145–154), undo and time travel (117, 156, 159), media (39, 124, 130), semantic domains and review-status fields unless the project adds them (78, 79, 85), allomorph entries (73), per-item approval inside a plan (98).

## Recurring themes (from the sources)

1. Finding the unfinished work, ordered by frequency.
2. Gloss inconsistency and abbreviation drift.
3. Propagating one decision everywhere.
4. Orthography changes after the fact, without losing analyses.
5. Lexicon hygiene: homographs, duplicates, missing POS/examples, unattested entries.
6. Harvesting examples for entries, papers, lessons.
7. Coverage and progress numbers.
8. Concordance in context.
9. Metadata completeness for archiving.
10. Trust in machine output: what was predicted vs confirmed.
11. Bulk edit with preview (and the wish for undo).
12. Interoperable export.

## Sources

FLEx documentation and training videos (concordance, interlinearize, Word Analyses, Bulk Edit, spelling status, export options, semantic domains, Send/Receive); flex-list threads on orthography change, glossing conventions, bulk edits, allomorphs, homographs, imports, spelling; Leipzig Glossing Rules and the Wikipedia abbreviation list; Lehmann's glossing guidelines; McGill LING 610 and SFA LING 434 field-methods syllabi; AILDI FLEx goals and tasks; UNT "From Source to Analysis"; GlossAssist (arXiv 2606.04367), GlossLM (2403.06399), word-by-word LLM glossing (2502.09778), ComputEL 2026 annotation-tool survey, Kokborok wordlist QC (2510.21584); PARADISEC and ELAR deposit and workflow guides, SSILA archiving note, ELDP training; corpus-analysis tutorials (linguisticsweb, Oxford LLDS); XLingPaper, FLEx-to-XeLaTeX, cldflex, interlineaR.
