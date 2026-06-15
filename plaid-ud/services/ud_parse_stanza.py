import stanza
import traceback
from plaid_client import (BaseService, TASKS, Param,
                          stamp_inferred, is_protected, service_source)


def prov_fragment(language):
    """Provenance fragment merged into everything this service creates
    (tokens, spans, relations): marks it machine-made + unverified until a
    human edits or confirms it, and records the producing model + language in
    provDetail. (Stanza's pipeline output carries no per-prediction
    probabilities, so there is no provProb; a producer that has real
    probabilities would add `prob=` here and put its top-k distribution in
    the detail map.) See the manual, "Provenance"."""
    return stamp_inferred(
        service_source('stanza-parser'),
        detail={'model': f'stanza=={stanza.__version__}', 'language': language},
    )


# Stanza ships UD models for many languages; offer a common subset. (value, label)
STANZA_LANGUAGES = [
    ('en', 'English'), ('de', 'German'), ('fr', 'French'), ('es', 'Spanish'),
    ('it', 'Italian'), ('pt', 'Portuguese'), ('nl', 'Dutch'), ('ru', 'Russian'),
    ('zh', 'Chinese'), ('ja', 'Japanese'), ('ar', 'Arabic'), ('ko', 'Korean'),
]

PARSER_SUMMARY = """\
Runs the [Stanza](https://stanfordnlp.github.io/stanza/) neural pipeline —
tokenization, POS tagging, lemmatization, and dependency parsing — and writes
the result into the project's sentence / word / morpheme layers plus the UD
annotation spans (Form, Lemma, UPOS, XPOS, Features) and dependency relations.

Two modes, picked automatically:

- **Untokenized document**: tokenize from scratch and build the whole
  hierarchy. Re-running replaces the document's existing tokens and
  annotations — across ALL apps sharing the project.
- **Already-tokenized document** (e.g. a project shared with IGT): the
  existing sentences and words are KEPT, and Stanza re-parses PER SENTENCE — a
  sentence is refreshed only if it has no human-made or human-verified UD
  annotations, so sentences you've reviewed or edited are left exactly as they
  are. Clicking Parse again thus refreshes the machine-only and not-yet-parsed
  sentences without disturbing your work. Other apps' annotations are
  untouched. (Trade-off: multiword tokens aren't split in this mode.)

Options:

- **Language** selects which Stanza models to use. The first parse in a given
  language downloads its models (one-time) and is slower.
- **Overwrite human-edited annotations**: by default, sentences carrying
  human-made or human-verified annotations are left untouched. Enable this to
  re-parse them too, discarding that work. (In a from-scratch re-tokenize it
  also lets the parse clear annotations that may belong to other apps sharing
  the project.)

Everything this service creates carries provenance metadata
(`prov`/`provSource`), so editors render it distinctly until a human verifies
it by editing or confirming.

While parsing, the document is locked so a concurrent editor can't race the
rewrite; if someone else holds the lock, the parse is refused rather than
clobbering their work.
"""

class PipelineProvider:
    """Lazily build and cache one Stanza pipeline per language.

    The pipelines are not thread-safe, so callers must build + drive them under
    a single-flight lock (BaseService.handle_service_request provides one). Each
    distinct language used adds one cached pipeline (and a one-time model
    download)."""

    def __init__(self, processors='tokenize,pos,lemma,depparse'):
        self.processors = processors
        self._cache = {}

    def get(self, language, pretokenized=False):
        # Pretokenized pipelines honor caller-supplied sentence/word splits
        # (used by the substrate-preserving parse mode). Cached separately:
        # tokenize_pretokenized is a pipeline-construction option.
        key = (language, pretokenized)
        pipe = self._cache.get(key)
        if pipe is None:
            print(f"Loading Stanza pipeline for '{language}' (pretokenized={pretokenized})…", flush=True)
            pipe = stanza.Pipeline(language, processors=self.processors,
                                   tokenize_pretokenized=pretokenized)
            self._cache[key] = pipe
        return pipe


def span_layer_by_ud_config(layers, key, fallback_name=None):
    for layer in layers:
        if layer.get("config", {}).get("ud", {}).get(key) is True:
            return layer
    if fallback_name:
        return next((layer for layer in layers if layer.get("name") == fallback_name), None)
    return None


def relation_layer_by_ud_config(span_layer, key, fallback_index=0):
    if not span_layer:
        return None
    relation_layers = span_layer.get("relation_layers") or []
    for relation_layer in relation_layers:
        if relation_layer.get("config", {}).get("ud", {}).get(key) is True:
            return relation_layer
    if relation_layers:
        try:
            return relation_layers[fallback_index]
        except IndexError:
            return relation_layers[0]
    return None


def token_layer_by_role(token_layers, role):
    # Substrate token layers are bound by their shared role (config.plaid.role),
    # NOT by the per-app ud.* flags. UD's "Morphemes" layer carries role
    # "syntactic-word" (it holds CoNLL-U syntactic words), not "morpheme".
    for layer in token_layers or []:
        if layer.get("config", {}).get("plaid", {}).get("role") == role:
            return layer
    return None


def make_bulk_token(token_layer_id, text, begin, end, metadata=None):
    op = {
        "token_layer_id": token_layer_id,
        "text": text,
        "begin": begin,
        "end": end,
    }
    if metadata:
        op["metadata"] = metadata
    return op


def make_span_token(span_layer_id, tokens, value, prov, metadata=None):
    # Every span this service creates is machine-made: the provenance
    # fragment is stamped unconditionally, with any caller metadata merged
    # over it.
    base = {
        "span_layer_id": span_layer_id,
        "tokens": tokens,
        "value": value,
        "metadata": {**prov, **(metadata or {})},
    }
    return base


def count_protected_annotations(token_layers):
    """Count human-made or human-verified annotations under the given token
    layers (write-contract guard). Returns (total, breakdown) where breakdown
    maps a human-readable label to a count, so the refusal can NAME what is
    in the way — on shared projects the annotations often belong to another
    app and are invisible in the UD editor.

    Tokens themselves are deliberately NOT counted: hand-tokenize-then-parse
    is the normal flow, and the contract protects annotation content, not
    substrate segmentation.
    """
    breakdown = {}

    def bump(label):
        breakdown[label] = breakdown.get(label, 0) + 1

    for token_layer in token_layers or []:
        tl_name = token_layer.get("name", "?")
        for span_layer in token_layer.get("span_layers", []) or []:
            label = f"{tl_name}/{span_layer.get('name', '?')}"
            for span in span_layer.get("spans", []) or []:
                if is_protected(span.get("metadata")):
                    bump(label)
            for relation_layer in span_layer.get("relation_layers", []) or []:
                rlabel = f"{label}/{relation_layer.get('name', '?')}"
                for relation in relation_layer.get("relations", []) or []:
                    if is_protected(relation.get("metadata")):
                        bump(rlabel)
        for vocab in token_layer.get("vocabs", []) or []:
            for link in vocab.get("vocab_links", []) or []:
                if is_protected(link.get("metadata")):
                    bump(f"{tl_name} vocab links")
    return sum(breakdown.values()), breakdown


def format_protected_error(total, breakdown, scope):
    top = sorted(breakdown.items(), key=lambda kv: -kv[1])
    listed = ", ".join(f"{label}: {n}" for label, n in top[:6])
    if len(top) > 6:
        listed += ", …"
    return (
        f"{total} human-made or human-verified annotation(s) exist {scope} "
        f"({listed}). Re-run with 'Overwrite human-edited annotations' enabled "
        f"to replace them — only if losing them is really what you want. "
        f"(Annotations from parses made before provenance stamping existed "
        f"also count as human-made.)"
    )


def _token_id(tok):
    """span/link `tokens` and relation endpoints come back as id strings;
    tolerate the occasional {id: ...} object shape too."""
    return tok.get("id") if isinstance(tok, dict) else tok


def morpheme_sentence_index(sent_groups, morphemes):
    """Map each syntactic-word (morpheme) token id to the index of its sentence
    in `sent_groups`, by character containment (the sentence layer partitions
    the text, so each morpheme falls in exactly one sentence)."""
    m2s = {}
    for m in morphemes or []:
        for idx, (sent, _ws) in enumerate(sent_groups):
            if sent["begin"] <= m["begin"] and m["end"] <= sent["end"]:
                m2s[m["id"]] = idx
                break
    return m2s


def _sentence_of_tokens(tokens, morph_to_sent):
    for tok in tokens or []:
        sidx = morph_to_sent.get(_token_id(tok))
        if sidx is not None:
            return sidx
    return None


def protected_sentence_indexes(morpheme_layer, lemma_layer, morph_to_sent):
    """Indexes (into sent_groups) of sentences carrying ANY human-made or
    human-verified UD annotation — a span on the syntactic-word layer, a
    dependency relation, or a vocab link. A selective re-parse leaves these
    sentences untouched. Scope matches the substrate-preserving blast radius
    (UD's own syntactic-word subtree); other apps' sibling layers are never
    touched here, so they don't gate anything."""
    protected = set()
    lemma_layer_id = lemma_layer.get("id") if lemma_layer else None
    lemma_span_to_sent = {}  # lemma span id -> sentence idx (relation endpoints)

    for span_layer in morpheme_layer.get("span_layers", []) or []:
        is_lemma = span_layer.get("id") == lemma_layer_id
        for span in span_layer.get("spans", []) or []:
            sidx = _sentence_of_tokens(span.get("tokens"), morph_to_sent)
            if is_lemma and sidx is not None:
                lemma_span_to_sent[span.get("id")] = sidx
            if sidx is not None and is_protected(span.get("metadata")):
                protected.add(sidx)

    for span_layer in morpheme_layer.get("span_layers", []) or []:
        for relation_layer in span_layer.get("relation_layers", []) or []:
            for rel in relation_layer.get("relations", []) or []:
                if not is_protected(rel.get("metadata")):
                    continue
                for endpoint in (rel.get("source"), rel.get("target")):
                    sidx = lemma_span_to_sent.get(endpoint)
                    if sidx is not None:
                        protected.add(sidx)

    for vocab in morpheme_layer.get("vocabs", []) or []:
        for link in vocab.get("vocab_links", []) or []:
            if not is_protected(link.get("metadata")):
                continue
            sidx = _sentence_of_tokens(link.get("tokens"), morph_to_sent)
            if sidx is not None:
                protected.add(sidx)

    return protected


def parse_document(pipeline_provider, client, document_id, language='en', overwrite=False):
    """Parse a document with Stanza and write UD annotations into Plaid.

    Two modes, chosen by what already exists:

    - FULL REPLACE (untokenized document): tokenize from scratch and create
      the three-layer hierarchy (sentences > words > syntactic words) plus
      the UD annotation spans and dependency relations. The sentence reset
      cascade-deletes EVERYTHING under the text layer — other apps' layers
      included — so the provenance guard walks the whole tree.
    - SUBSTRATE-PRESERVING (sentence + word tokens already exist, e.g. a
      project shared with another app): keep the existing tokenization and
      re-parse PER SENTENCE — only sentences with no human-made/verified UD
      annotation are refreshed (Stanza runs pretokenized over their words,
      replacing UD's syntactic-word tokens + spans/relations for just those
      sentences); sentences a human has touched are left untouched. Limitation:
      pretokenized Stanza does not split multiword tokens, so each word gets
      exactly one syntactic word (annotators can still split by hand).

    Provenance write contract: everything created here is stamped machine-made
    (prov_fragment). A re-parse replaces machine-made UNVERIFIED material but
    never human-made/verified work: substrate-preserving mode skips sentences
    that carry any (unless `overwrite`); a from-scratch re-tokenize refuses
    outright if such annotations would be lost (unless `overwrite`). Returns a
    summary dict {mode, parsed_sentences, skipped_sentences}."""
    frag = prov_fragment(language)

    def log(msg):
        # Force-flush so the next-line-after-hang shows whatever the last
        # successful step was, even if Python's stdout is block-buffered.
        print(msg, flush=True)

    try:
        log(f"Starting parse for document {document_id}")

        # Resolve layers FIRST — the parse mode depends on what exists.
        log("Fetching document with layers…")
        full_document = client.documents.get(document_id, include_body=True)
        log("  …document fetched")
        text_layers = full_document["text_layers"]
        text_layer = next(
            (tl for tl in text_layers
             if tl.get("config", {}).get("plaid", {}).get("role") == "baseline"),
            text_layers[0],
        )
        text_id = text_layer["text"]["id"]
        body = text_layer["text"]["body"]
        # The parse runs on (and computes offsets into) THIS baseline body. We
        # deliberately re-resolve it here rather than trusting a caller-supplied
        # string: the baseline-role layer is not necessarily text_layers[0] on a
        # multi-text-layer document, and parsing one string while offsetting into
        # another would corrupt every token.
        if not (body or "").strip():
            raise RuntimeError(f"Text content is empty for document {document_id}")

        token_layers = text_layer.get("token_layers", [])
        sentence_layer = token_layer_by_role(token_layers, "sentence")
        word_layer = token_layer_by_role(token_layers, "word")
        morpheme_layer = token_layer_by_role(token_layers, "syntactic-word")

        if not (sentence_layer and word_layer and morpheme_layer):
            raise RuntimeError("Project is missing the sentence/word/morpheme token layers")

        span_layers = morpheme_layer.get("span_layers", [])
        form_layer = span_layer_by_ud_config(span_layers, "form", "Form")
        lemma_layer = span_layer_by_ud_config(span_layers, "lemma", "Lemma")
        upos_layer = span_layer_by_ud_config(span_layers, "upos", "UPOS")
        xpos_layer = span_layer_by_ud_config(span_layers, "xpos", "XPOS")
        features_layer = span_layer_by_ud_config(span_layers, "features", "Features")

        existing_sentences = sorted(sentence_layer.get("tokens") or [], key=lambda t: t["begin"])
        existing_words = sorted(word_layer.get("tokens") or [], key=lambda t: (t["begin"], t["end"]))
        existing_morphemes = morpheme_layer.get("tokens", []) or []
        log(f"Existing tokens: {len(existing_sentences)} sentences, "
            f"{len(existing_words)} words, {len(existing_morphemes)} syntactic words")

        preserve = bool(existing_sentences and existing_words)

        if preserve:
            # ----- SUBSTRATE-PRESERVING mode (sentence-selective) -----------
            # Re-parse only sentences that carry NO human-made/verified UD
            # annotation; sentences a human has reviewed/edited are left exactly
            # as they are. This is the "click Parse again" path — it refreshes
            # the machine-only and not-yet-parsed sentences without disturbing
            # your work. `overwrite` re-parses every sentence regardless.

            # Group the existing words under their containing sentences (the
            # sentence layer is partitioning, so containment is well-defined);
            # keep the sentence object alongside for per-sentence decisions.
            sent_groups = []  # [(sentence_token, [word_tokens])]
            for sent in existing_sentences:
                ws = [w for w in existing_words
                      if sent["begin"] <= w["begin"] and w["end"] <= sent["end"]]
                sent_groups.append((sent, ws))
            grouped_count = sum(len(ws) for _, ws in sent_groups)
            if grouped_count != len(existing_words):
                log(f"  WARNING: {len(existing_words) - grouped_count} word token(s) "
                    f"fall outside the sentence partition; they get no syntactic word")

            morph_to_sent = morpheme_sentence_index(sent_groups, existing_morphemes)
            protected_idxs = protected_sentence_indexes(morpheme_layer, lemma_layer, morph_to_sent)

            # Sentences to (re)parse: those with words and — unless overwrite —
            # no human annotations. Carry the original index for clear errors.
            reparse = [(idx, sent, ws) for idx, (sent, ws) in enumerate(sent_groups)
                       if ws and (overwrite or idx not in protected_idxs)]
            reparse_idxs = {idx for idx, _, _ in reparse}
            skipped_idxs = protected_idxs - reparse_idxs
            log(f"Sentence-selective parse: {len(reparse)} sentence(s) to (re)parse; "
                f"{len(skipped_idxs)} with human annotations "
                + ("re-parsed anyway (overwrite on)" if overwrite else "left untouched"))

            if not reparse:
                log("Nothing to (re)parse — every sentence with words has human annotations.")
                return {"mode": "preserve", "parsed_sentences": 0,
                        "skipped_sentences": len(skipped_idxs)}

            log("Preserving existing tokenization; parsing pretokenized…")
            pipeline = pipeline_provider.get(language, pretokenized=True)
            stanza_doc = pipeline([[body[w["begin"]:w["end"]] for w in ws] for _, _, ws in reparse])
            sentences_data = stanza_doc.to_dict()

            # Delete syntactic-word tokens of the RE-PARSED sentences only
            # (cascades their UD spans/relations); skipped sentences keep theirs.
            morphs_to_delete = [m for m in existing_morphemes
                                if morph_to_sent.get(m["id"]) in reparse_idxs]
            if morphs_to_delete:
                log(f"  Deleting {len(morphs_to_delete)} syntactic-word token(s) in re-parsed "
                    f"sentences (cascades UD spans/relations only)…")
                client.tokens.bulk_delete([m["id"] for m in morphs_to_delete])

            sentence_ops, word_ops = [], []  # substrate preserved
            morpheme_ops = []
            # `sent_idx` here is the index INTO `sentences_data` (the re-parsed
            # subset), so the shared span/relation code below stays consistent.
            morpheme_meta = []  # parallel to morpheme_ops: {sent_idx, row, word_substring}
            for r_idx, ((orig_idx, sent, ws), sentence_data) in enumerate(zip(reparse, sentences_data)):
                rows = [td for td in sentence_data if not isinstance(td["id"], tuple)]
                if len(rows) != len(ws):
                    # A misalignment would hang annotations on the wrong
                    # words — fail loudly rather than guess.
                    raise RuntimeError(
                        f"Pretokenized parse returned {len(rows)} words for a "
                        f"{len(ws)}-word sentence (original index {orig_idx}); aborting")
                for w, row in zip(ws, rows):
                    op = make_bulk_token(morpheme_layer["id"], text_id,
                                         w["begin"], w["end"], metadata=dict(frag))
                    op["precedence"] = 0
                    morpheme_ops.append(op)
                    morpheme_meta.append({"sent_idx": r_idx, "row": row,
                                          "word_substring": body[w["begin"]:w["end"]]})
            parse_summary = {"mode": "preserve", "parsed_sentences": len(reparse),
                             "skipped_sentences": len(skipped_idxs)}
        else:
            # ----- FULL-REPLACE mode -----------------------------------------
            # The sentence cascade destroys EVERYTHING under the text layer —
            # other apps' layers included — so the guard walks the whole tree.
            protected, breakdown = count_protected_annotations(token_layers)
            if protected and not overwrite:
                raise RuntimeError(format_protected_error(
                    protected, breakdown,
                    "on this document (they may belong to other apps sharing the project)"))
            if protected:
                log(f"Overwrite enabled: replacing {protected} protected annotation(s)")

            log("Tokenizing + parsing from scratch…")
            pipeline = pipeline_provider.get(language)
            stanza_doc = pipeline(body)
            sentences_data = stanza_doc.to_dict()
            log(f"Parsed {len(sentences_data)} sentences")
            parse_summary = {"mode": "full", "parsed_sentences": len(sentences_data),
                             "skipped_sentences": 0}

            # Reset: delete pre-existing tokens, leaning on server-side cascade
            # for the normal case. Deleting sentences cascades to their words +
            # morphemes server-side in one shot. The lower elif branches only
            # kick in for half-parsed states (sentences absent but lower layers
            # left over from a botched mid-flight parse). Doing this top-down
            # rather than bottom-up matters a lot for perf: an explicit
            # bottom-up cycle for a 285-word doc ran ~30s server-side (each
            # word delete runs constraint queries individually), while a
            # single-sentence cascade collapses that into one server-side
            # transaction. (preserve=False means at most one branch fires.)
            if existing_sentences:
                log(f"  Deleting {len(existing_sentences)} sentences (cascades to words + morphemes)…")
                client.tokens.bulk_delete([t["id"] for t in existing_sentences])
            elif existing_words:
                log(f"  Deleting {len(existing_words)} orphan words (no sentences to cascade from)…")
                client.tokens.bulk_delete([t["id"] for t in existing_words])
            elif existing_morphemes:
                log(f"  Deleting {len(existing_morphemes)} orphan morphemes…")
                client.tokens.bulk_delete([t["id"] for t in existing_morphemes])

            # 1. Sentence tokens: a gap-free partition of [0, len(body)). Sentence i
            #    runs from its first token to the start of sentence i+1, so inter-
            #    sentence whitespace stays with the preceding sentence; sentence 0
            #    starts at 0 and the last sentence ends at len(body).
            n_sents = len(stanza_doc.sentences)
            starts = [0 if i == 0 else sent.tokens[0].start_char
                      for i, sent in enumerate(stanza_doc.sentences)]
            sentence_ops = []
            for i in range(n_sents):
                begin = starts[i]
                end = starts[i + 1] if i + 1 < n_sents else len(body)
                op = make_bulk_token(sentence_layer["id"], text_id, begin, end)
                # Preserve the Stanza-recovered sentence text on the sentence token so
                # the exporter can round-trip it (e.g. when surface forms differ from
                # the body slice — contractions, normalized punctuation). Provenance
                # rides alongside the round-trip data.
                op["metadata"] = {"text": stanza_doc.sentences[i].text, **frag}
                sentence_ops.append(op)

            # 2/3. Word and morpheme tokens. Each surface token is a word; each
            #      integer-id syntactic word is a morpheme that inhabits the FULL
            #      width of its word (multiword-token components share the extent).
            word_ops = []
            morpheme_ops = []
            morpheme_meta = []  # parallel to morpheme_ops: {sent_idx, row, word_substring}
            for sent_idx, sentence_data in enumerate(sentences_data):
                i = 0
                while i < len(sentence_data):
                    td = sentence_data[i]
                    if isinstance(td["id"], tuple):
                        start_id, end_id = td["id"]
                        count = end_id - start_id + 1
                        wb, we = td["start_char"], td["end_char"]
                        # Persist the MWT surface form on the word token's
                        # metadata so the exporter can round-trip it. (1:1 words
                        # leave metadata clean; the body substring is canonical.)
                        word_meta = dict(frag)
                        if td.get("text") and td["text"] != body[wb:we]:
                            word_meta["form"] = td["text"]
                        if td.get("misc"):
                            word_meta["misc"] = td["misc"]
                        word_ops.append(make_bulk_token(
                            word_layer["id"], text_id, wb, we, metadata=word_meta
                        ))
                        members = sentence_data[i + 1:i + 1 + count]
                        for prec, member in enumerate(members):
                            op = make_bulk_token(morpheme_layer["id"], text_id, wb, we,
                                                 metadata=dict(frag))
                            op["precedence"] = prec
                            morpheme_ops.append(op)
                            morpheme_meta.append({"sent_idx": sent_idx, "row": member, "word_substring": body[wb:we]})
                        i += 1 + count
                    else:
                        wb, we = td["start_char"], td["end_char"]
                        word_ops.append(make_bulk_token(word_layer["id"], text_id, wb, we,
                                                        metadata=dict(frag)))
                        op = make_bulk_token(morpheme_layer["id"], text_id, wb, we,
                                             metadata=dict(frag))
                        op["precedence"] = 0
                        morpheme_ops.append(op)
                        morpheme_meta.append({"sent_idx": sent_idx, "row": td, "word_substring": body[wb:we]})
                        i += 1

        # Combine the creations into a single atomic batch (server runs them
        # sequentially, so child layers see the parents from earlier ops in
        # the same batch — those creates don't reference the *ids* produced
        # earlier in the batch, only the pre-existing layer ids). Order is
        # top-down (sentences → words → morphemes) — a child without its
        # parent on the server is a 400. In substrate-preserving mode the
        # sentence/word op lists are empty and only syntactic words land.
        log(f"Building token ops: {len(sentence_ops)} sentences, "
            f"{len(word_ops)} words, {len(morpheme_ops)} morphemes")
        client.begin_batch()
        order = []  # which kind sits at each index in submit_batch results
        try:
            if sentence_ops:
                client.tokens.bulk_create(sentence_ops)
                order.append("sentences")
            if word_ops:
                client.tokens.bulk_create(word_ops)
                order.append("words")
            if morpheme_ops:
                client.tokens.bulk_create(morpheme_ops)
                order.append("morphemes")
            log(f"  Submitting token batch ({len(order)} ops)…")
            token_results = client.submit_batch() if order else []
            log("  …token batch returned")
        finally:
            # If submit_batch wasn't reached (e.g., `order` was empty, or an
            # exception fired mid-queue), drop the dangling batch so later
            # plain calls (including send_message in response_helper) don't
            # silently queue into a never-submitted batch.
            if client.is_batch_mode():
                client.abort_batch()
        morpheme_ids = []
        if "sentences" in order:
            log(f"Created {len(sentence_ops)} sentence tokens")
        if "words" in order:
            log(f"Created {len(word_ops)} word tokens")
        if "morphemes" in order:
            idx = order.index("morphemes")
            morpheme_ids = token_results[idx]["body"]["ids"]
            log(f"Created {len(morpheme_ids)} morpheme tokens")

        # 4. Annotation spans on morphemes.
        lemma_span_ids = []
        for sentence_data in sentences_data:
            row_count = sum(1 for td in sentence_data if not isinstance(td["id"], tuple))
            lemma_span_ids.append([None] * row_count)

        form_spans, lemma_spans, lemma_targets = [], [], []
        upos_spans, xpos_spans, feature_spans = [], [], []
        for i, meta in enumerate(morpheme_meta):
            mid = morpheme_ids[i] if i < len(morpheme_ids) else None
            if not mid:
                continue
            row = meta["row"]
            sent_idx = meta["sent_idx"]
            row_index = row["id"] - 1

            form = row.get("text")
            # A Form span is only needed when the surface form differs from the
            # morpheme's substring (i.e. real MWT components).
            if form_layer and form and form != meta["word_substring"]:
                form_spans.append(make_span_token(form_layer["id"], [mid], form, frag))
            lemma = row.get("lemma")
            if lemma_layer and lemma:
                lemma_spans.append(make_span_token(lemma_layer["id"], [mid], lemma, frag))
                lemma_targets.append((sent_idx, row_index))
            upos = row.get("upos")
            if upos_layer and upos:
                upos_spans.append(make_span_token(upos_layer["id"], [mid], upos, frag))
            xpos = row.get("xpos")
            if xpos_layer and xpos:
                xpos_spans.append(make_span_token(xpos_layer["id"], [mid], xpos, frag))
            feats = row.get("feats")
            if features_layer and feats:
                for value in feats.split("|"):
                    if value:
                        feature_spans.append(make_span_token(features_layer["id"], [mid], value, frag))

        # Bundle all five span bulk_creates into ONE atomic batch so a partial
        # failure rolls the spans back together. Track the batch index of
        # lemma so we can recover the new span ids for the follow-up relation
        # batch.
        #
        # Note: unlike the JS importer (which creates a new document and
        # deletes it on any failure), the parser operates on an EXISTING user
        # document. We don't delete on failure — the user re-runs the parse;
        # the cascade-delete at the top of `parse_document` clears any
        # partial-state tokens before re-creating.
        log(f"Building span ops: form={len(form_spans)}, lemma={len(lemma_spans)}, "
            f"upos={len(upos_spans)}, xpos={len(xpos_spans)}, features={len(feature_spans)}")
        client.begin_batch()
        span_order = []
        try:
            if form_spans:
                client.spans.bulk_create(form_spans)
                span_order.append("form")
            if lemma_spans:
                client.spans.bulk_create(lemma_spans)
                span_order.append("lemma")
            if upos_spans:
                client.spans.bulk_create(upos_spans)
                span_order.append("upos")
            if xpos_spans:
                client.spans.bulk_create(xpos_spans)
                span_order.append("xpos")
            if feature_spans:
                client.spans.bulk_create(feature_spans)
                span_order.append("features")
            log(f"  Submitting span batch ({len(span_order)} ops)…")
            span_results = client.submit_batch() if span_order else []
            log("  …span batch returned")
        finally:
            # Same safety as the token batch: never leave the client in
            # batch mode if submit_batch didn't run, or send_message inside
            # response_helper will silently queue and the web client will
            # time out.
            if client.is_batch_mode():
                client.abort_batch()
        if "lemma" in span_order:
            lemma_idx = span_order.index("lemma")
            created = span_results[lemma_idx]["body"]["ids"]
            for k, (sent_idx, row_index) in enumerate(lemma_targets):
                lemma_span_ids[sent_idx][row_index] = created[k]
        for kind in span_order:
            count = {"form": len(form_spans), "lemma": len(lemma_spans),
                     "upos": len(upos_spans), "xpos": len(xpos_spans),
                     "features": len(feature_spans)}[kind]
            label = {"form": "form", "lemma": "lemma", "upos": "UPOS",
                     "xpos": "XPOS", "features": "feature"}[kind]
            log(f"Created {count} {label} spans")

        # 5. Dependency relations on lemma spans.
        relation_layer = relation_layer_by_ud_config(lemma_layer, "dependency")
        if relation_layer and lemma_layer:
            relation_ops = []
            for sent_idx, sentence_data in enumerate(sentences_data):
                sentence_lemma_ids = lemma_span_ids[sent_idx]
                for td in sentence_data:
                    if isinstance(td["id"], tuple):
                        continue
                    row_index = td["id"] - 1
                    target = sentence_lemma_ids[row_index]
                    deprel = td.get("deprel")
                    head = td.get("head")
                    if not deprel or target is None:
                        continue
                    if head == 0:
                        relation_ops.append({
                            "relation_layer_id": relation_layer["id"],
                            "source": target,
                            "target": target,
                            "value": deprel,
                            "metadata": dict(frag),
                        })
                    elif head and head > 0 and head - 1 < len(sentence_lemma_ids):
                        source = sentence_lemma_ids[head - 1]
                        if source is not None:
                            relation_ops.append({
                                "relation_layer_id": relation_layer["id"],
                                "source": source,
                                "target": target,
                                "value": deprel,
                                "metadata": dict(frag),
                            })
            if relation_ops:
                log(f"  Creating {len(relation_ops)} dependency relations…")
                client.relations.bulk_create(relation_ops)
                log("  …relations created")

        log(f"Successfully parsed document {document_id}")
        return parse_summary

    except Exception as e:
        print(f"Error parsing document {document_id}: {e}", flush=True)
        traceback.print_exc()
        raise e
    finally:
        # Belt-and-suspenders: if we somehow exit parse_document with the
        # client still in batch mode, drop it so the caller's response_helper
        # send_message doesn't silently queue.
        if client.is_batch_mode():
            client.abort_batch()


class StanzaParserService(BaseService):
    """Stanza-based UD parser served on every accessible project.

    Built on the shared `BaseService` SDK (client/token bootstrap, registration,
    the single-flight processing lock, and the CLI loop). Per-request user args
    (`language`, `overwrite`) are declared in the parameter schema below and read
    back from `request_data` in `process_request`. Audit attribution comes from
    the named API token the service authenticates with (mint one under
    Profile → API Tokens), so the rows it writes are attributable to the machine.
    """

    def __init__(self):
        super().__init__(
            service_id='stanza-parser',
            service_name='Stanza Parser',
            description=('Provides document parsing using Stanza pipeline with '
                         'tokenization, POS tagging, lemmatization, and dependency parsing'),
            tasks=[TASKS.PARSE],
            summary=PARSER_SUMMARY,
            parameters=[
                Param.enum('language', 'Language', STANZA_LANGUAGES, default='en',
                           description='Language models Stanza uses for parsing.'),
                Param.boolean('overwrite', 'Overwrite human-edited annotations', default=False,
                              description='Re-parse sentences even where a human created or '
                                          'verified annotations (discarding them). When off, '
                                          'those sentences are left untouched.'),
            ],
        )
        self.pipeline_provider = None

    def setup(self, args):
        # Pipelines are built lazily per requested language and cached; preload
        # the default so the common case is warm at startup.
        print("Loading Stanza pipeline (en)…")
        self.pipeline_provider = PipelineProvider(processors='tokenize,pos,lemma,depparse')
        self.pipeline_provider.get('en')

    def process_request(self, request_data, response_helper):
        # `BaseService.handle_service_request` already wraps this in a
        # non-blocking single-flight lock — only one parse runs at a time across
        # every served project, which is what the shared (not thread-safe) Stanza
        # pipelines need — and reports any exception via response_helper.error.
        # So this just does the work; a second concurrent request is rejected
        # with "try again later" rather than queued (parsing is CPU-bound).
        print(f"Received service request: {request_data}")
        document_id = request_data.get('document_id')
        # User-controlled arguments (declared in the parameter schema above; the
        # client delivers request keys to Python as snake_case).
        language = request_data.get('language', 'en')
        overwrite = bool(request_data.get('overwrite', False))

        response_helper.progress(10, f"Starting document parsing ({language})...")
        # The parse deletes + recreates tokens / spans / relations, so a human
        # editing the same document — or another service — would race the
        # rewrite. Hold plaid-core's server-enforced document lock for the
        # duration: writes by another user are rejected with 423 while we hold
        # it, and if someone else already holds it `locked` raises and we refuse
        # rather than clobber their work.
        response_helper.progress(15, "Acquiring document lock...")
        with self.client.documents.locked(document_id):
            summary = parse_document(self.pipeline_provider, self.client, document_id,
                                     language=language, overwrite=overwrite)

        # parse_document returns a summary dict; report what it actually did.
        parsed = summary.get("parsed_sentences", 0)
        skipped = summary.get("skipped_sentences", 0)
        msg = f"Parsed {parsed} sentence(s)"
        if skipped:
            msg += f"; kept {skipped} sentence(s) with human annotations"
        response_helper.progress(100, msg)
        # Outbound keys are snake_case (already so in `summary`): the client's
        # snake→kebab transform on send + the JS client's kebab→camel on receive
        # deliver them to the UI as camelCase.
        response_helper.complete({"document_id": document_id, "status": "success", **summary})


if __name__ == '__main__':
    # CLI (handled by BaseService.run):
    #   python ud_parse_stanza.py                → serve ALL accessible projects
    #   python ud_parse_stanza.py --all          → serve ALL accessible projects
    #   python ud_parse_stanza.py PROJECT_ID     → serve one project
    #   --url URL                                → Plaid API URL (default :8085)
    StanzaParserService().run()
