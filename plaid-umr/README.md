# Plaid UMR - Uniform Meaning Representation Annotation

A React application for annotating Uniform Meaning Representation graphs on the Plaid
linguistic annotation platform.

## Prerequisites

- Node.js 24
- A Plaid server on port **8085**. That is the port of the `clojure -X:dev` development
  server, which is what `npm run dev` proxies `/api` to (see `vite.config.js`). A release
  `java -jar plaid.jar` listens on 8080 instead, so point the proxy there if that is what
  you are running.

## Quick start

1. Start a Plaid server. From `plaid-core/`:
   ```bash
   clojure -X:dev   # then type (start) at the REPL
   ```
2. `npm install`
3. `npm run dev`

## Annotation model

The text, the sentences and the words are the shared substrate, made and edited in
plaid-igt or plaid-ud; this app reads them and annotates over them. What UMR owns is a
root token layer of node anchors and, on it, a concept span layer with two relation
layers:

- **UMR nodes** - token layer, `overlap-mode: any`, one token per contiguous anchor
  piece. A root layer rather than a child of Words, because an unaligned concept is a
  zero-width token and the server refuses those on a nested layer.
- **UMR concepts** - span layer, one span per graph node. The span's value is the
  concept; `metadata.umr` carries the variable, the attributes and the root mark.
- **UMR relations** - the sentence-level edges. **UMR document graph** - the temporal,
  modal and coreference triples.

Substrate layers are found by their shared `config.plaid.role`; the four layers above by
their `config.umr` flag. `src/utils/umrLayerUtils.js` is the one resolver.

## Drafting with a language model

`services/umr_draft_llm.py` registers a service that writes a first UMR graph for each
sentence of a document: concepts, roles, attributes and word alignments, stamped
machine-made and ready to be corrected on the canvas. It is reached from the **Draft**
button on the annotation page, and the service a project uses for that spot is chosen
under Settings, Services.

The model is an operator's choice at launch, not a request parameter, so nobody can point
the service at another endpoint with your key. Any provider litellm reaches will do:

```bash
# A hosted provider (the key comes from OPENAI_API_KEY, or pass --api-key)
python services/umr_draft_llm.py --url http://localhost:8085 --model openai/gpt-4o-mini

# A local Ollama model
python services/umr_draft_llm.py --url http://localhost:8085 --model ollama/llama3.1

# Any OpenAI-compatible server (vLLM, llama.cpp, a proxy)
python services/umr_draft_llm.py --url http://localhost:8085 \
    --model openai/my-model --api-base http://gpu-box:8000/v1
```

Pass one or more project ids to serve just those projects; with none it serves every
project the token can access, including ones created later. Run it once per model, with
`--service-id`, to offer a project a choice of several.

Requirements on top of `plaid-client`: `litellm` (`pip install litellm`, which needs
Python 3.11 or newer). The service parses the model's PENMAN with its own reader, so
nothing else has to be installed.

## A skeleton from glosses, with no model

`services/umr_bootstrap_igt.py` registers a second drafting method for the same **Draft**
spot: from the vocabulary links and glosses the project already has, it writes one anchored
node per word, the entry's headword or the gloss's lexical part as the concept and the
grammatical abbreviations as attributes (`3SG`, `NEG`, `HAB`), and marks the word carrying
tense or aspect as the root. It draws no relations: those are the annotator's, on the canvas.

```bash
python services/umr_bootstrap_igt.py --url http://localhost:8085
# A language whose glosses go beyond the Leipzig rules: a JSON table of abbreviations
python services/umr_bootstrap_igt.py --url http://localhost:8085 --abbreviations arapaho.json
```

No requirements beyond `plaid-client`.

## Adjudicating with AnCast

`services/umr_ancast.py` registers the service behind the **Compare** tab: it scores this
document's UMR against another document of the same project with the AnCast++ metric (Sun
and Xue 2024), and writes the report on the scored document under
`metadata.umr.adjudication`. Nothing is annotated. The usual pair is one text annotated
twice, which is what Copy document makes.

```bash
python services/umr_ancast.py --url http://localhost:8085
```

Requirements on top of `plaid-client`: `ancast` (`pip install ancast`, which brings numpy).

## Testing

- `npm test` is lint plus both JS suites. `npm run test:unit` is `node --test` over
  `test/*.test.js`; `npm run test:components` is vitest. Node 24 (`nvm use 24.1.0`).
- `npm run test:e2e:own` runs the Playwright suite against its own dev server.
- `pytest -q services/tests` runs the drafting service's handler tests. They stand the
  chat model in at its one seam, so they need no provider and no key, and run from the
  base Python environment.
