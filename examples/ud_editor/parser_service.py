import sys
import stanza
import requests
from client import PlaidClient


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


def span_layer_by_name(layers, name):
    return next((layer for layer in layers if layer["name"] == name))


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
    """Parse a document using Stanza and create annotations in Plaid"""
    try:
        # Parse with Stanza
        print(f"Starting parse for document {document_id}")
        stanza_doc = pipeline(text_content)
        sentences_data = stanza_doc.to_dict()
        print(f"Parsed {len(sentences_data)} sentences")
        
        # Get document with layers to find token layer ID
        full_document = client.documents.get(document_id, True)
        text_layer = full_document["text_layers"][0]
        text_id = text_layer["text"]["id"]
        token_layer = text_layer["token_layers"][0]

        # Bulk delete all existing tokens (this will cascade delete spans and relations)
        existing_tokens = token_layer["tokens"]
        if existing_tokens:
            token_ids = [token['id'] for token in existing_tokens]
            print(f"Bulk deleting {len(token_ids)} existing tokens")
            client.tokens.bulk_delete(token_ids)

        # Get span layers for annotations
        span_layers = token_layer["span_layers"]
        lemma_layer = span_layer_by_name(span_layers, "Lemma")
        upos_layer = span_layer_by_name(span_layers, "UPOS")
        xpos_layer = span_layer_by_name(span_layers, "XPOS")
        features_layer = span_layer_by_name(span_layers, "Features")
        sentence_layer = span_layer_by_name(span_layers, "Sentence")
        mwt_layer = span_layer_by_name(span_layers, "Multi-word Tokens")
        
        # Create tokens
        token_operations = []
        for sent_idx, sentence_data in enumerate(sentences_data):
            for token_data in sentence_data:
                # Skip multi-word tokens (they have tuple IDs)
                if isinstance(token_data['id'], tuple):
                    continue
                token = make_bulk_token(token_layer["id"], text_id, token_data["start_char"], token_data["end_char"])
                token_operations.append(token)
        print(f"Creating {len(token_operations)} tokens")
        token_result = client.tokens.bulk_create(token_operations)
        created_token_ids = token_result["ids"]
        
        # Create sentences and map token IDs to sentences
        token_id_map = []
        global_token_index = 0
        sentence_spans = []
        for i, sentence_data in enumerate(sentences_data):
            sentence_token_ids = []
            for token_data in sentence_data:
                # Skip multi-word tokens (they have tuple IDs)
                if isinstance(token_data['id'], tuple):
                    continue
                # Note Plaid ID for a given token
                token_id = created_token_ids[global_token_index]
                # Mark sentence beginning
                if len(sentence_token_ids) == 0:
                    sentence_spans.append(make_span_token(sentence_layer["id"], [token_id], None, {"text": stanza_doc.sentences[i].text}))
                sentence_token_ids.append(token_id)
                global_token_index += 1
            token_id_map.append(sentence_token_ids)
        # Make sentence beginning spans
        if sentence_spans:
            client.spans.bulk_create(sentence_spans)
            print(f"Created {len(sentence_spans)} sentence spans")

        def create_spans(layer, layer_name, token_key):
            spans = []
            span_positions = []  # Track positions for ID mapping
            
            for sent_idx, sentence_data in enumerate(sentences_data):
                sentence_token_ids = token_id_map[sent_idx]
                tok_idx = 0
                for token_data in sentence_data:
                    # Skip multi-word tokens (they have tuple IDs)
                    if isinstance(token_data['id'], tuple):
                        continue
                    value = token_data.get(token_key, None)
                    value_list = [] if value is None else value.split("|") if token_key == "feats" else [value]

                    for value in value_list:
                        if value:  # Skip empty/None values
                            tokens_for_span = [sentence_token_ids[tok_idx]]
                            spans.append(make_span_token(layer["id"], tokens_for_span, value))
                            span_positions.append((sent_idx, tok_idx))
                    
                    tok_idx += 1
            
            if spans:
                result = client.spans.bulk_create(spans)
                created_ids = result.get('ids', [])
                print(f"Created {len(spans)} {layer_name} spans")
                return created_ids, span_positions

            return None, []

        # Lemma spans (need IDs for relations)
        lemma_ids, lemma_positions = create_spans(lemma_layer, "lemma", "lemma")
        # Map lemma span IDs for relations
        lemma_span_ids = [[None] * len([t for t in sentence_data if not isinstance(t['id'], tuple)]) for sentence_data in sentences_data]
        if lemma_ids and lemma_positions:
            for i, (sent_idx, tok_idx) in enumerate(lemma_positions):
                lemma_span_ids[sent_idx][tok_idx] = lemma_ids[i]
        
        create_spans(upos_layer, "UPOS", "upos")
        create_spans(xpos_layer, "XPOS", "xpos")
        create_spans(features_layer, "feature", "feats")
        
        # Create multi-word token spans
        if mwt_layer:
            mwt_spans = []
            for sent_idx, sentence_data in enumerate(sentences_data):
                sentence_token_ids = token_id_map[sent_idx]
                for token_data in sentence_data:
                    # Only process multi-word tokens (they have tuple IDs)
                    if not isinstance(token_data['id'], tuple):
                        continue
                        
                    # Find tokens that correspond to this MWT
                    start_id, end_id = token_data['id']
                    start_idx = start_id - 1  # Convert to 0-based
                    end_idx = end_id - 1      # Convert to 0-based

                    # Include all tokens from start to end (inclusive)
                    mwt_token_ids = sentence_token_ids[start_idx:end_idx + 1]
                    mwt_spans.append(make_span_token(mwt_layer["id"], mwt_token_ids, token_data["text"]))

            if mwt_spans:
                client.spans.bulk_create(mwt_spans)
                print(f"Created {len(mwt_spans)} multi-word token spans")
        
        # Create dependency relations
        if lemma_layer and lemma_span_ids:
            relation_layer = lemma_layer.get('relation_layers', [{}])[0] if lemma_layer.get('relation_layers') else None
            
            if relation_layer:
                relation_operations = []
                
                for sent_idx, sentence_data in enumerate(sentences_data):
                    sentence_lemma_ids = lemma_span_ids[sent_idx]
                    
                    tok_idx = 0
                    for token_data in sentence_data:
                        # Skip multi-word tokens (they have tuple IDs)
                        if isinstance(token_data['id'], tuple):
                            continue
                            
                        target_lemma_id = sentence_lemma_ids[tok_idx]
                        
                        if token_data.get('deprel') and target_lemma_id:
                            if token_data.get('head') == 0:
                                # Root relation
                                relation_operations.append({
                                    'relation_layer_id': relation_layer['id'],
                                    'source': target_lemma_id,
                                    'target': target_lemma_id,
                                    'value': token_data['deprel']
                                })
                            else:
                                # Regular relation
                                head_idx = token_data['head'] - 1  # Convert to 0-based
                                if 0 <= head_idx < len(sentence_lemma_ids):
                                    source_lemma_id = sentence_lemma_ids[head_idx]
                                    if source_lemma_id:
                                        relation_operations.append({
                                            'relation_layer_id': relation_layer['id'],
                                            'source': source_lemma_id,
                                            'target': target_lemma_id,
                                            'value': token_data['deprel']
                                        })
                        
                        tok_idx += 1
                
                if relation_operations:
                    client.relations.bulk_create(relation_operations)
                    print(f"Created {len(relation_operations)} dependency relations")
        
        print(f"Successfully parsed document {document_id}")
        return True
        
    except Exception as e:
        print(f"Error parsing document {document_id}: {e}")
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
        document_id = request_data.get('document_id')
        try:
            # Get document content
            document = client.documents.get(document_id, True)
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
