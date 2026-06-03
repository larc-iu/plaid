# Plaid UD - Universal Dependencies Annotation

A React-based demo application for editing Universal Dependencies trees using the Plaid linguistic annotation platform.

## Prerequisites

- Node.js 16+ installed
- Plaid server running on port 8085 (default)

## Quick Start

1. Make sure Plaid server is running:
   ```bash
   java -jar plaid.jar
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

## Annotation model

Each UD project uses a three-layer **token hierarchy** on a single text layer
(see `src/utils/udLayerUtils.js`):

- **Sentences** — token layer, `overlap-mode: partitioning` (tiles the whole text).
- **Words** — token layer, `overlap-mode: non-overlapping`, nested in sentences.
  These are UD *surface tokens* (orthographic words, including multiword tokens).
- **Morphemes** — token layer, `overlap-mode: any`, nested in words. These are UD
  *syntactic words* (the numbered CoNLL-U rows) and carry all annotation.

Parentage is by character-offset containment (there is no explicit parent field).
A multiword token is a word with more than one morpheme; every morpheme inhabits
the **full width** of its word and is distinguished by `precedence` and its **Form**
span. Annotation span layers (Form, Lemma, UPOS, XPOS, Features) and the
dependency relation layer all hang off the morpheme layer.

Projects are configured from the project configuration screen (which creates the
hierarchy above). This is a breaking change from the older single-token-layer
projects, which must be reconfigured.

## Auto-parsing (Stanza)

`parser_service.py` registers a Stanza-based NLP service that fills in the whole
hierarchy (sentences, words, morphemes, annotations, dependencies) for a document:

```bash
python parser_service.py PROJECT_ID [PLAID_URL]
```