import sys
import threading
import stanza
import requests
import traceback
from plaid_client import PlaidClient, TASKS, Param, build_extras


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

- **Language** selects which Stanza models to use. The first parse in a given
  language downloads its models (one-time) and is slower.

> Re-running replaces the document's existing tokens and annotations.
"""

# Standardized self-description carried in `extras` for discovery. The parameter
# `language` is read back as `request_data['language']` in the handler.
PARSER_EXTRAS = build_extras(
    tasks=[TASKS.PARSE],
    summary=PARSER_SUMMARY,
    parameters=[
        Param.enum('language', 'Language', STANZA_LANGUAGES, default='en',
                   description='Language models Stanza uses for parsing.'),
    ],
)


class PipelineProvider:
    """Lazily build and cache one Stanza pipeline per language.

    The pipelines are not thread-safe, so callers must build + drive them under
    the shared parse lock (see `make_handler`). Each distinct language used adds
    one cached pipeline (and a one-time model download)."""

    def __init__(self, processors='tokenize,pos,lemma,depparse'):
        self.processors = processors
        self._cache = {}

    def get(self, language):
        pipe = self._cache.get(language)
        if pipe is None:
            print(f"Loading Stanza pipeline for '{language}'…", flush=True)
            pipe = stanza.Pipeline(language, processors=self.processors)
            self._cache[language] = pipe
        return pipe


def get_token(api_url):
    """Resolve a token from `.token`, prompting + validating on first run.

    Returns the raw token STRING (not a client) so each served project can
    get its own client instance with it.

    Prefer a named API token, minted in the web UI under your user profile's
    "API Tokens" panel. Unlike a login session token it doesn't expire,
    survives password changes, can be revoked on its own, and — because it's a
    distinct credential — its name shows up in the audit history, so the rows
    this parser writes are clearly attributable to the machine. Paste it once
    and it's cached in `.token`.
    """
    try:
        with open(".token", "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        while True:
            token = input("Enter Plaid API token (create one in the web UI: Profile → API Tokens): ").strip()
            try:
                _ = PlaidClient(api_url, token).projects.list()
            except requests.exceptions.HTTPError as e:
                print("Error when attempting to connect to Plaid API: {}".format(e))
                continue
            with open(".token", "w") as f:
                f.write(token)
                print("Token valid. Wrote token to .token")
            return token


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


def make_span_token(span_layer_id, tokens, value, metadata=None):
    base = {
        "span_layer_id": span_layer_id,
        "tokens": tokens,
        "value": value,
    }
    if metadata is not None:
        base["metadata"] = metadata
    return base


def parse_document(pipeline, client, document_id, text_content):
    """Parse a document with Stanza and create the three-layer token hierarchy
    (sentences > words > morphemes) plus annotations in Plaid."""
    def log(msg):
        # Force-flush so the next-line-after-hang shows whatever the last
        # successful step was, even if Python's stdout is block-buffered.
        print(msg, flush=True)

    try:
        log(f"Starting parse for document {document_id}")
        stanza_doc = pipeline(text_content)
        sentences_data = stanza_doc.to_dict()
        log(f"Parsed {len(sentences_data)} sentences")

        # Resolve layers
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

        # Reset: delete pre-existing tokens, leaning on server-side cascade
        # for the normal case. Deleting sentences cascades to their words +
        # morphemes server-side in one shot. The lower elif branches only
        # kick in for half-parsed states (sentences absent but lower layers
        # left over from a botched mid-flight parse). Doing this top-down
        # rather than bottom-up matters a lot for perf: an explicit
        # bottom-up cycle for a 285-word doc ran ~30s server-side (each
        # word delete runs constraint queries individually), while a
        # single-sentence cascade collapses that into one server-side
        # transaction.
        existing_sentences = sentence_layer.get("tokens", [])
        existing_words = word_layer.get("tokens", [])
        existing_morphemes = morpheme_layer.get("tokens", [])
        log(f"Existing tokens: {len(existing_sentences)} sentences, "
            f"{len(existing_words)} words, {len(existing_morphemes)} morphemes")
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
            # the body slice — contractions, normalized punctuation).
            op["metadata"] = {"text": stanza_doc.sentences[i].text}
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
                    word_meta = {}
                    if td.get("text") and td["text"] != body[wb:we]:
                        word_meta["form"] = td["text"]
                    if td.get("misc"):
                        word_meta["misc"] = td["misc"]
                    word_ops.append(make_bulk_token(
                        word_layer["id"], text_id, wb, we, metadata=word_meta or None
                    ))
                    members = sentence_data[i + 1:i + 1 + count]
                    for prec, member in enumerate(members):
                        op = make_bulk_token(morpheme_layer["id"], text_id, wb, we)
                        op["precedence"] = prec
                        morpheme_ops.append(op)
                        morpheme_meta.append({"sent_idx": sent_idx, "row": member, "word_substring": body[wb:we]})
                    i += 1 + count
                else:
                    wb, we = td["start_char"], td["end_char"]
                    word_ops.append(make_bulk_token(word_layer["id"], text_id, wb, we))
                    op = make_bulk_token(morpheme_layer["id"], text_id, wb, we)
                    op["precedence"] = 0
                    morpheme_ops.append(op)
                    morpheme_meta.append({"sent_idx": sent_idx, "row": td, "word_substring": body[wb:we]})
                    i += 1

        # Combine sentences/words/morphemes into a single atomic batch (server
        # runs them sequentially, so child layers see the parents from earlier
        # ops in the same batch — those creates don't reference the *ids*
        # produced earlier in the batch, only the pre-existing layer ids).
        # Order is top-down (sentences → words → morphemes) — a child without
        # its parent on the server is a 400.
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
                form_spans.append(make_span_token(form_layer["id"], [mid], form))
            lemma = row.get("lemma")
            if lemma_layer and lemma:
                lemma_spans.append(make_span_token(lemma_layer["id"], [mid], lemma))
                lemma_targets.append((sent_idx, row_index))
            upos = row.get("upos")
            if upos_layer and upos:
                upos_spans.append(make_span_token(upos_layer["id"], [mid], upos))
            xpos = row.get("xpos")
            if xpos_layer and xpos:
                xpos_spans.append(make_span_token(xpos_layer["id"], [mid], xpos))
            feats = row.get("feats")
            if features_layer and feats:
                for value in feats.split("|"):
                    if value:
                        feature_spans.append(make_span_token(features_layer["id"], [mid], value))

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
                        })
                    elif head and head > 0 and head - 1 < len(sentence_lemma_ids):
                        source = sentence_lemma_ids[head - 1]
                        if source is not None:
                            relation_ops.append({
                                "relation_layer_id": relation_layer["id"],
                                "source": source,
                                "target": target,
                                "value": deprel,
                            })
            if relation_ops:
                log(f"  Creating {len(relation_ops)} dependency relations…")
                client.relations.bulk_create(relation_ops)
                log("  …relations created")

        log(f"Successfully parsed document {document_id}")
        return True

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


# The Python client's `serve()` reads snake_case keys here (`service_id` /
# `service_name`), unlike most of the rest of plaid-client which is camelCase.
# Don't be misled by the camelCase `serviceId` you'll see in messages on the
# wire — that's the JSON shape; this dict is a kwargs bag for the Python helper.
SERVICE_INFO = {
    'service_id': 'stanza-parser',
    'service_name': 'Stanza Parser',
    'description': 'Provides document parsing using Stanza pipeline with tokenization, POS tagging, lemmatization, and dependency parsing'
}


def make_handler(client, pipeline_provider, parse_lock):
    """Build a per-project service-request handler bound to that project's own
    `client`. Each served project gets its own client so batch state (which is
    per-client, mutable instance state) never collides across projects' SSE
    threads."""
    def handle_service_request(request_data, response_helper):
        """Handle structured service requests for document parsing.

        The Python client normalizes incoming JSON keys to snake_case before
        the handler runs (see `transform_response` in plaid_client/transforms.py),
        so the JS sender's `documentId` arrives here as `document_id`. The
        outbound `response_helper.complete(...)` payload goes through the
        symmetric snake→kebab transform on send, so use snake_case here too.
        """
        print(f"Received service request: {request_data}")
        document_id = request_data.get('document_id')
        # User-controlled argument (declared in PARSER_EXTRAS' parameter schema).
        language = request_data.get('language', 'en')
        try:
            # Get document content
            document = client.documents.get(document_id, include_body=True)
            text_layer = document["text_layers"][0]
            text_content = text_layer["text"]["body"]
            if not text_content.strip():
                response_helper.error(f"Text content is empty for document {document_id}")
                return

            # Send progress updates
            response_helper.progress(10, f"Starting document parsing ({language})...")

            # Serialize the actual parse across ALL served projects: the Stanza
            # pipelines are shared and not thread-safe, and parse_document drives
            # this project's client through batch mode. With one SSE thread per
            # served project, two requests could otherwise run concurrently; the
            # lock makes them run one at a time. (Document fetch + the empty
            # check above stay outside the lock — they're per-client reads.)
            # Building the per-language pipeline also happens under the lock,
            # since Stanza model loading is not thread-safe.
            with parse_lock:
                pipeline = pipeline_provider.get(language)
                success = parse_document(pipeline, client, document_id, text_content)

            if success:
                response_helper.progress(100, "Document parsing completed successfully")
                response_helper.complete({"document_id": document_id, "status": "success"})
            else:
                response_helper.error("Document parsing failed")

        except Exception as e:
            print(f"Error during parse: {str(e)}")
            response_helper.error(f"Parsing error: {str(e)}")
            traceback.print_exc()

    return handle_service_request


def serve_project(api_url, token, project_id, pipeline_provider, parse_lock):
    """Register the Stanza service on a single project. Returns its
    ServiceRegistration (one SSE connection / daemon thread)."""
    client = PlaidClient(api_url, token)
    # Audit attribution comes from the named API token the client authenticates
    # with (its name shows up as the actor in the audit log). Mint one in the
    # web UI under Profile → API Tokens.
    handler = make_handler(client, pipeline_provider, parse_lock)
    # The standardized self-description (tasks/summary/parameters) rides along
    # for discovery as the 4th `serve` argument.
    return client.messages.serve(project_id, SERVICE_INFO, handler, PARSER_EXTRAS)


def main():
    # CLI:
    #   python parser_service.py                 → serve ALL accessible projects
    #   python parser_service.py --all [URL]     → serve ALL accessible projects
    #   python parser_service.py PROJECT_ID [URL]→ serve one project (back-compat)
    #
    # "All accessible" = exactly the set the token's user can reach
    # (`projects.list()`). Service registration is project-scoped server-side
    # (one SSE stream per project at /projects/:id/listen), so universal
    # coverage is achieved by fanning out one registration per project.
    argv = sys.argv[1:]
    serve_all = False
    project_id = None
    if argv and argv[0] == "--all":
        serve_all = True
        argv = argv[1:]
    elif argv:
        project_id = argv[0]
        argv = argv[1:]
    else:
        # No positional project given → default to universal coverage.
        serve_all = True
    api_url = argv[0] if argv else "http://localhost:8085"

    token = get_token(api_url)
    bootstrap = PlaidClient(api_url, token)

    # Resolve the target project set.
    if serve_all:
        try:
            projects = bootstrap.projects.list()
        except requests.exceptions.HTTPError as e:
            print(f"Failed to list projects: {e}", file=sys.stderr)
            sys.exit(1)
        targets = [(p["id"], p.get("name", p["id"])) for p in projects]
        if not targets:
            print("Token has access to no projects; nothing to serve.", file=sys.stderr)
            sys.exit(1)
    else:
        try:
            proj = bootstrap.projects.get(project_id)
        except requests.exceptions.HTTPError as e:
            print(f"Invalid project ID {project_id}: {e}", file=sys.stderr)
            sys.exit(1)
        targets = [(project_id, proj.get("name", project_id))]

    # Pipelines are built lazily per requested language and cached; preload the
    # default so the common case is warm at startup.
    print("Loading Stanza pipeline (en)…")
    pipeline_provider = PipelineProvider(processors='tokenize,pos,lemma,depparse')
    pipeline_provider.get('en')
    # One global lock serializes parses across every project's SSE thread (the
    # pipelines are shared + not thread-safe). Parsing is CPU-bound, so one-at-a-
    # time is the right model regardless.
    parse_lock = threading.Lock()

    registrations = []
    for pid, pname in targets:
        try:
            reg = serve_project(api_url, token, pid, pipeline_provider, parse_lock)
            registrations.append((pid, pname, reg))
            print(f"  Serving project {pname} ({pid})")
        except Exception as e:
            # A project the token can list but not register on (e.g. lost access
            # mid-flight) shouldn't take down the whole service.
            print(f"  Skipping project {pid}: failed to register service: {e}", file=sys.stderr)

    if not registrations:
        print("No services registered; exiting.", file=sys.stderr)
        sys.exit(1)

    print(f"Stanza Parser registered on {len(registrations)} project(s). Waiting for requests...")
    print("Press Ctrl+C to stop.")

    try:
        # ServiceRegistration objects expose is_running()/stop() directly.
        import time
        while any(reg.is_running() for _, _, reg in registrations):
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping service(s)...")
        for _, _, reg in registrations:
            try:
                reg.stop()
            except Exception:
                pass
        print("Service(s) stopped.")


if __name__ == '__main__':
    main()
