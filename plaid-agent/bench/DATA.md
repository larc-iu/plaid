# Benchmark data

Everything in the benchmark database comes from the public sources below, fetched on 2026-10-08 into `fixtures/src/` of the data directory (`$PLAID_BENCH_DATA`, README.md). No production data is in it. Task prompts are written for the benchmark.

`fixtures/build.sh` turns these into `fixtures/snapshot/` (see `fixtures/build.py`). The manifest there records the project and document ids, the core code the database was made with, and the commit of the importers.

## IGT: SIGMORPHON 2023 Shared Task on Interlinear Glossing

- Source: https://github.com/sigmorphon/2023glossingST, `data_v1/`, at commit `190689ac81935359c69a46463c48e25e63e601f7` (also in `fixtures/src/sigmorphon2023/COMMIT`).
- Files: the dev split, track 2 (morpheme segmentation given), "uncovered" (glosses present): `lez-dev-track2-uncovered`, `ntu-dev-track2-uncovered`, `git-dev-track2-uncovered`.
- License: each language's `LICENSE` file in the repo, copied next to the data. Lezgi and Natugu: CC BY-NC 4.0. Gitksan: CC BY-NC-ND 4.0.
- Projects:
  - `igt-lezgi`, "Lezgi (SIGMORPHON 2023)": 88 sentences (all of them) in 5 documents of 20, 992 words, 1129 morphemes. Cyrillic.
  - `igt-natugu`, "Natugu (SIGMORPHON 2023)": 99 sentences in 5 documents, 1280 words, 1901 morphemes. Latin.
  - `igt-gitksan`, "Gitksan (SIGMORPHON 2023)": 42 sentences in 3 documents, 388 words, 604 morphemes. Latin.
- How: `fixtures/sigmorphon_to_cldf.py` writes a CLDF TextCorpus (pycldf) that plaid-igt's own CLDF import reads, with the wizard's project setup. The `\t` line is the text and each word is placed at its surface form (a `Surface_Word` column), the `\m` segmentation becomes the morphemes (`metadata.form`, which is often an underlying form that differs from the surface), `\g` the morpheme glosses, `\l` the sentence translation. Punctuation gets no gloss. A line whose word or morpheme counts disagree would be dropped, and none did.
- Lexicon: each project has a vocabulary "Lexicon" with one entry per distinct morpheme form (lowercased) and one sense per distinct gloss it has in the data (Lezgi 374 entries and 411 senses, Natugu 407 and 464, Gitksan 133 and 147). NO morpheme is linked to an entry. Same-form entries with several senses give homograph and polysemy material.

## UD: Universal Dependencies 2.18

- Source: https://github.com/UniversalDependencies, tag `r2.18`, the `*-ud-dev.conllu` file of each treebank, with its `LICENSE.txt` and `README.md`.
- Projects (the first 60 dev sentences each, in 3 documents of 20):
  - `ud-french`, "French GSD (UD 2.18)": UD_French-GSD. Latin script, multiword tokens (du, au, des). CC BY-SA 4.0.
  - `ud-russian`, "Russian GSD (UD 2.18)": UD_Russian-GSD. Cyrillic, no multiword tokens. CC BY-SA 4.0.
  - `ud-arabic`, "Arabic PADT (UD 2.18)": UD_Arabic-PADT. Arabic script, right to left, many multiword tokens. CC BY-NC-SA 3.0.
- How: `fixtures/conllu_slice.py` cuts the sentences, plaid-ud's own `createUdProject` and `importConlluDocument` load them. What the importer does not keep is dropped as it says: the MISC column (French and Arabic), and one empty node with its enhanced dependencies (Arabic 3).

## UMR: Uniform Meaning Representation 2.0

- Source: LINDAT/CLARIAH-CZ, hdl:11234/1-5902, "UMR Release 2.0.zip" (sha256 `41d42946e13663de8ce8062a6d9b2a80f53e36d34191a5afd47eaca91b0b2d76`). Only the Kukama folder and the release README are kept in `fixtures/src/umr2.0/`.
- License: Kukama is CC BY-NC-ND 4.0 (its README). Contributors: Meagan Vigus, Jens E. Van Gysel, Rosa Vallejos Yopán. Speakers and consultants are acknowledged in the same README.
- Project `umr-kukama`, "Kukama (UMR 2.0)": one document, "Kukama text 2" (`kukama_umr-0002.umr`), 19 sentences, 118 words, 176 morphemes, 111 graph nodes, 110 relations. Built as a UMR project over interlinear text is: the file's Words, Morphemes, English morpheme glosses and English translation become an igt project through the CLDF import (`fixtures/umr_to_cldf.py`, morphemes grouped into words by their joints), then the project is adopted for UMR and the file's graphs are attached onto that document (plaid-umr's `adoptSubstrate` and `importUmrDocument` with `into`). Every word in this file grouped cleanly, so every word is analyzed. The importer warns once per obsolete gloss header in the 2.0 file format, which is expected. The Spanish lines are not carried.
- Why Kukama text 2: it is the fieldwork set where every word segments and every sentence has glosses and translations, and text 2 is small enough for a benchmark.

## Users

A = `a@b.com` (admin), B = `b@x.com` and C = `c@x.com`, writers on every project and maintainers of every vocabulary, and `reader@x.com` with no membership. Each of A, B and C has a named API token "bench" in the manifest. These are sandbox credentials on a private database.

## Sharing

The UD and SIGMORPHON data are redistributable under their licenses with attribution (some non-commercial). Kukama and Gitksan are CC BY-NC-ND 4.0: the benchmark may use them and a published benchmark may point to them, but should not redistribute a modified version (the built database is one). Publishing the task set with `fixtures/build.sh` and the source URLs, rather than the built database, respects all of them.
