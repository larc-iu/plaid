import sys
import stanza
import requests
import traceback
from plaid_client import PlaidClient


def get_client(api_url):
    try:
        with open(".token", "r") as f:
            token = f.read()
    except FileNotFoundError:
        while True:
            token = input("Enter Plaid API token: ").strip()
            client = PlaidClient(api_url, token)
            try:
                _ = client.projects.list()
            except requests.exceptions.HTTPError as e:
                print("Error when attempting to connect to Plaid API: {}".format(e))
                continue
            with open(f".token", "w") as f:
                f.write(token)
                print("Token valid. Wrote token to .token")
            break
    return PlaidClient(api_url, token)


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


def token_layer_by_ud_config(token_layers, key):
    for layer in token_layers or []:
        if layer.get("config", {}).get("ud", {}).get(key) is True:
            return layer
    return None


def make_bulk_token(token_layer_id, text, begin, end):
    return {
        "token_layer_id": token_layer_id,
        "text": text,
        "begin": begin,
        "end": end
    }


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
    try:
        print(f"Starting parse for document {document_id}")
        stanza_doc = pipeline(text_content)
        sentences_data = stanza_doc.to_dict()
        print(f"Parsed {len(sentences_data)} sentences")

        # Resolve layers
        full_document = client.documents.get(document_id, include_body=True)
        text_layer = full_document["text_layers"][0]
        text_id = text_layer["text"]["id"]
        body = text_layer["text"]["body"]

        token_layers = text_layer.get("token_layers", [])
        sentence_layer = token_layer_by_ud_config(token_layers, "sentenceTokenLayer")
        word_layer = token_layer_by_ud_config(token_layers, "wordTokenLayer")
        morpheme_layer = token_layer_by_ud_config(token_layers, "morphemeTokenLayer")

        if not (sentence_layer and word_layer and morpheme_layer):
            raise RuntimeError("Project is missing the sentence/word/morpheme token layers")

        span_layers = morpheme_layer.get("span_layers", [])
        form_layer = span_layer_by_ud_config(span_layers, "form", "Form")
        lemma_layer = span_layer_by_ud_config(span_layers, "lemma", "Lemma")
        upos_layer = span_layer_by_ud_config(span_layers, "upos", "UPOS")
        xpos_layer = span_layer_by_ud_config(span_layers, "xpos", "XPOS")
        features_layer = span_layer_by_ud_config(span_layers, "features", "Features")

        # Reset: delete any pre-existing tokens at every level. Three
        # independent branches (not if/elif) so a half-parsed state with orphan
        # words or morphemes but no sentences still gets cleared. Order is
        # bottom-up (morphemes → words → sentences) to be safe even if server
        # cascade is off or partial.
        existing_sentences = sentence_layer.get("tokens", [])
        existing_words = word_layer.get("tokens", [])
        existing_morphemes = morpheme_layer.get("tokens", [])
        if existing_morphemes:
            client.tokens.bulk_delete([t["id"] for t in existing_morphemes])
        if existing_words:
            client.tokens.bulk_delete([t["id"] for t in existing_words])
        if existing_sentences:
            client.tokens.bulk_delete([t["id"] for t in existing_sentences])

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
                    word_ops.append(make_bulk_token(word_layer["id"], text_id, wb, we))
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
        client.begin_batch()
        order = []  # which kind sits at each index in submit_batch results
        if sentence_ops:
            client.tokens.bulk_create(sentence_ops)
            order.append("sentences")
        if word_ops:
            client.tokens.bulk_create(word_ops)
            order.append("words")
        if morpheme_ops:
            client.tokens.bulk_create(morpheme_ops)
            order.append("morphemes")
        token_results = client.submit_batch() if order else []
        morpheme_ids = []
        if "sentences" in order:
            print(f"Created {len(sentence_ops)} sentence tokens")
        if "words" in order:
            print(f"Created {len(word_ops)} word tokens")
        if "morphemes" in order:
            idx = order.index("morphemes")
            morpheme_ids = token_results[idx]["body"]["ids"]
            print(f"Created {len(morpheme_ids)} morpheme tokens")

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

        if form_spans:
            client.spans.bulk_create(form_spans)
            print(f"Created {len(form_spans)} form spans")
        if lemma_spans:
            created = client.spans.bulk_create(lemma_spans)["ids"]
            for k, (sent_idx, row_index) in enumerate(lemma_targets):
                lemma_span_ids[sent_idx][row_index] = created[k]
            print(f"Created {len(lemma_spans)} lemma spans")
        if upos_spans:
            client.spans.bulk_create(upos_spans)
            print(f"Created {len(upos_spans)} UPOS spans")
        if xpos_spans:
            client.spans.bulk_create(xpos_spans)
            print(f"Created {len(xpos_spans)} XPOS spans")
        if feature_spans:
            client.spans.bulk_create(feature_spans)
            print(f"Created {len(feature_spans)} feature spans")

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
                client.relations.bulk_create(relation_ops)
                print(f"Created {len(relation_ops)} dependency relations")

        print(f"Successfully parsed document {document_id}")
        return True

    except Exception as e:
        print(f"Error parsing document {document_id}: {e}")
        traceback.print_exc()
        raise e


def main():
    if len(sys.argv) < 2:
        print("Usage: `python parser_service.py PROJECT_ID [URL]`", file=sys.stderr)
        sys.exit(1)
    client = get_client(sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8085")
    client.set_agent_name("Stanza Parser")
    target_project_id = sys.argv[1]
    try:
        client.projects.get(target_project_id)
    except requests.exceptions.HTTPError as e:
        print(f"Invalid project ID {target_project_id}: {e}", file=sys.stderr)
        sys.exit(1)

    pipeline = stanza.Pipeline('en', processors='tokenize,pos,lemma,depparse')

    def handle_service_request(request_data, response_helper):
        """Handle structured service requests for document parsing"""
        print(f"Received service request: {request_data}")
        document_id = request_data.get('documentId')
        try:
            # Get document content
            document = client.documents.get(document_id, include_body=True)
            text_layer = document["text_layers"][0]
            text_content = text_layer["text"]["body"]
            if not text_content.strip():
                response_helper.error(f"Text content is empty for document {document_id}")
                return

            # Send progress updates
            response_helper.progress(10, "Starting document parsing...")
            
            # Perform the parse
            success = parse_document(pipeline, client, document_id, text_content)
            
            if success:
                response_helper.progress(100, "Document parsing completed successfully")
                response_helper.complete({"documentId": document_id, "status": "success"})
            else:
                response_helper.error("Document parsing failed")

        except Exception as e:
            print(f"Error during parse: {str(e)}")
            response_helper.error(f"Parsing error: {str(e)}")
            traceback.print_exc()

    # Register as a structured service
    service_info = {
        'serviceId': 'stanza-parser',
        'serviceName': 'Stanza Parser',
        'description': 'Provides document parsing using Stanza pipeline with tokenization, POS tagging, lemmatization, and dependency parsing'
    }
    
    print(f"Registering as service: {service_info}")
    print(f"Starting NLP service, listening to project {target_project_id}")
    
    service_registration = client.messages.serve(target_project_id, service_info, handle_service_request)
    
    print("Service registered successfully. Waiting for requests...")
    print("Press Ctrl+C to stop the service.")
    
    try:
        # Keep the service running
        while service_registration['isRunning']():
            import time
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping service...")
        service_registration['stop']()
        print("Service stopped.")


if __name__ == '__main__':
    main()
