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

def stanza_to_conllu(stanza_doc):
    """Convert Stanza Document to CoNLL-U format structured data"""
    sentences = []
    
    for stanza_sent in stanza_doc.sentences:
        # Collect all tokens and multi-word tokens
        tokens = []
        multi_word_tokens = []
        
        # Process tokens (which may be multi-word)
        for token in stanza_sent.tokens:
            if len(token.words) > 1:
                # Multi-word token
                start_id = token.words[0].id
                end_id = token.words[-1].id
                multi_word_tokens.append({
                    'start': start_id,
                    'end': end_id,
                    'form': token.text,
                    'misc': None
                })
            
            # Add individual words from this token
            for word in token.words:
                # Parse features
                feats = []
                if word.feats:
                    feats = word.feats.split('|')
                
                tokens.append({
                    'id': word.id,
                    'form': word.text,
                    'lemma': word.lemma,
                    'upos': word.upos,
                    'xpos': word.xpos,
                    'feats': feats,
                    'head': word.head,
                    'deprel': word.deprel
                })
        
        # Sort tokens by ID to ensure proper ordering
        tokens.sort(key=lambda x: x['id'])
        
        # Create sentence structure
        sentence = {
            'tokens': tokens,
            'multiWordTokens': multi_word_tokens,
            'metadata': {
                'text': stanza_sent.text
            }
        }
        
        sentences.append(sentence)
    
    return {'sentences': sentences}


def parse_document(pipeline, client, document_id, text_content):
    """Parse a document using Stanza and create annotations in Plaid"""
    try:
        print(f"Starting parse for document {document_id}")
        
        # Parse with Stanza
        stanza_doc = pipeline(text_content)
        
        # Convert to CoNLL-U format
        parsed_data = stanza_to_conllu(stanza_doc)
        
        print(f"Parsed {len(parsed_data['sentences'])} sentences")
        
        # Get document with layers to find IDs
        full_document = client.documents.get(document_id, True)
        text_layer = full_document.get('text_layers', [{}])[0] if full_document.get('text_layers') else None
        
        if not text_layer:
            raise Exception("No text layer found in document")
            
        # Get existing text
        existing_text = text_layer.get('text')
        if not existing_text:
            raise Exception("No text found in text layer")
        
        text_id = existing_text['id']
        text_content_from_db = existing_text.get('body', '')
        
        # Get token layer for bulk delete
        token_layer = text_layer.get('token_layers', [{}])[0] if text_layer.get('token_layers') else None
        if not token_layer:
            raise Exception("No token layer found")
        
        # Bulk delete all existing tokens (this will cascade delete spans and relations)
        existing_tokens = token_layer.get('tokens', [])
        if existing_tokens:
            token_ids = [token['id'] for token in existing_tokens]
            print(f"Bulk deleting {len(token_ids)} existing tokens")
            client.tokens.bulk_delete(token_ids)
        
        # Use the actual database text content for token positioning
        text_content = text_content_from_db
        
        # Get span layers for annotations
        span_layers = token_layer.get('span_layers', [])
        lemma_layer = next((layer for layer in span_layers if layer['name'] == 'Lemma'), None)
        upos_layer = next((layer for layer in span_layers if layer['name'] == 'UPOS'), None)
        xpos_layer = next((layer for layer in span_layers if layer['name'] == 'XPOS'), None)
        features_layer = next((layer for layer in span_layers if layer['name'] == 'Features'), None)
        sentence_layer = next((layer for layer in span_layers if layer['name'] == 'Sentence'), None)
        mwt_layer = next((layer for layer in span_layers if layer['name'] == 'Multi-word Tokens'), None)
        
        # Calculate token positions using the actual text content
        token_positions = []
        current_pos = 0
        
        for sent_idx, sentence in enumerate(parsed_data['sentences']):
            sentence_positions = []
            
            for token in sentence['tokens']:
                token_form = token['form']
                
                # Find the token in the remaining text
                token_start = text_content.find(token_form, current_pos)
                
                if token_start == -1:
                    # If we can't find the token, skip ahead by token length as fallback
                    print(f"Warning: Could not find token '{token_form}' in text at position {current_pos}")
                    token_begin = current_pos
                    token_end = current_pos + len(token_form)
                    current_pos = token_end
                else:
                    token_begin = token_start
                    token_end = token_start + len(token_form)
                    current_pos = token_end
                
                sentence_positions.append({'begin': token_begin, 'end': token_end})
            
            token_positions.append(sentence_positions)
        
        # Create tokens in bulk
        token_operations = []
        for sent_idx, sentence in enumerate(parsed_data['sentences']):
            sentence_positions = token_positions[sent_idx]
            for tok_idx, position in enumerate(sentence_positions):
                token_operations.append({
                    'token_layer_id': token_layer['id'],
                    'text': text_id,
                    'begin': position['begin'],
                    'end': position['end']
                })

        print(f"Creating {len(token_operations)} tokens")
        token_result = client.tokens.bulk_create(token_operations)
        created_token_ids = token_result.get('ids', [])
        
        # Map token IDs to sentences
        token_id_map = []
        global_token_index = 0
        for sentence in parsed_data['sentences']:
            sentence_token_ids = []
            for _ in sentence['tokens']:
                sentence_token_ids.append(created_token_ids[global_token_index])
                global_token_index += 1
            token_id_map.append(sentence_token_ids)
        
        # Create spans for each layer
        lemma_span_ids = [[None] * len(sentence['tokens']) for sentence in parsed_data['sentences']]
        
        # Create sentence spans
        if sentence_layer:
            sentence_spans = []
            for sent_idx, sentence_token_ids in enumerate(token_id_map):
                if sentence_token_ids:
                    metadata = parsed_data['sentences'][sent_idx]['metadata']
                    sentence_spans.append({
                        'span_layer_id': sentence_layer['id'],
                        'tokens': [sentence_token_ids[0]],
                        'value': None,
                        'metadata': metadata if metadata else None
                    })
            
            if sentence_spans:
                client.spans.bulk_create(sentence_spans)
                print(f"Created {len(sentence_spans)} sentence spans")
        
        # Create lemma spans
        if lemma_layer:
            lemma_spans = []
            lemma_operations = []
            
            for sent_idx, sentence in enumerate(parsed_data['sentences']):
                sentence_token_ids = token_id_map[sent_idx]
                for tok_idx, token in enumerate(sentence['tokens']):
                    if token['lemma']:
                        lemma_spans.append({
                            'span_layer_id': lemma_layer['id'],
                            'tokens': [sentence_token_ids[tok_idx]],
                            'value': token['lemma']
                        })
                        lemma_operations.append({'sentenceIndex': sent_idx, 'tokenIndex': tok_idx})
            
            if lemma_spans:
                result = client.spans.bulk_create(lemma_spans)
                created_lemma_ids = result.get('ids', [])
                print(f"Created {len(lemma_spans)} lemma spans")
                
                # Map lemma span IDs for relations
                for i, operation in enumerate(lemma_operations):
                    lemma_span_ids[operation['sentenceIndex']][operation['tokenIndex']] = created_lemma_ids[i]
        
        # Create UPOS spans
        if upos_layer:
            upos_spans = []
            for sent_idx, sentence in enumerate(parsed_data['sentences']):
                sentence_token_ids = token_id_map[sent_idx]
                for tok_idx, token in enumerate(sentence['tokens']):
                    if token['upos']:
                        upos_spans.append({
                            'span_layer_id': upos_layer['id'],
                            'tokens': [sentence_token_ids[tok_idx]],
                            'value': token['upos']
                        })
            
            if upos_spans:
                client.spans.bulk_create(upos_spans)
                print(f"Created {len(upos_spans)} UPOS spans")
        
        # Create XPOS spans
        if xpos_layer:
            xpos_spans = []
            for sent_idx, sentence in enumerate(parsed_data['sentences']):
                sentence_token_ids = token_id_map[sent_idx]
                for tok_idx, token in enumerate(sentence['tokens']):
                    if token['xpos']:
                        xpos_spans.append({
                            'span_layer_id': xpos_layer['id'],
                            'tokens': [sentence_token_ids[tok_idx]],
                            'value': token['xpos']
                        })
            
            if xpos_spans:
                client.spans.bulk_create(xpos_spans)
                print(f"Created {len(xpos_spans)} XPOS spans")
        
        # Create feature spans
        if features_layer:
            feature_spans = []
            for sent_idx, sentence in enumerate(parsed_data['sentences']):
                sentence_token_ids = token_id_map[sent_idx]
                for tok_idx, token in enumerate(sentence['tokens']):
                    for feat in token['feats']:
                        feature_spans.append({
                            'span_layer_id': features_layer['id'],
                            'tokens': [sentence_token_ids[tok_idx]],
                            'value': feat
                        })
            
            if feature_spans:
                client.spans.bulk_create(feature_spans)
                print(f"Created {len(feature_spans)} feature spans")
        
        # Create multi-word token spans
        if mwt_layer:
            mwt_spans = []
            for sent_idx, sentence in enumerate(parsed_data['sentences']):
                sentence_token_ids = token_id_map[sent_idx]
                for mwt in sentence['multiWordTokens']:
                    # Find tokens that correspond to this MWT
                    start_idx = mwt['start'] - 1  # Convert to 0-based
                    end_idx = mwt['end'] - 1      # Convert to 0-based
                    
                    if 0 <= start_idx < len(sentence_token_ids) and 0 <= end_idx < len(sentence_token_ids):
                        # Include all tokens from start to end (inclusive)
                        mwt_token_ids = sentence_token_ids[start_idx:end_idx + 1]
                        mwt_spans.append({
                            'span_layer_id': mwt_layer['id'],
                            'tokens': mwt_token_ids,
                            'value': mwt['form']
                        })
            
            if mwt_spans:
                client.spans.bulk_create(mwt_spans)
                print(f"Created {len(mwt_spans)} multi-word token spans")
        
        # Create dependency relations
        if lemma_layer and lemma_span_ids:
            relation_layer = lemma_layer.get('relation_layers', [{}])[0] if lemma_layer.get('relation_layers') else None
            
            if relation_layer:
                relation_operations = []
                
                for sent_idx, sentence in enumerate(parsed_data['sentences']):
                    sentence_lemma_ids = lemma_span_ids[sent_idx]
                    
                    for tok_idx, token in enumerate(sentence['tokens']):
                        target_lemma_id = sentence_lemma_ids[tok_idx]
                        
                        if token['deprel'] and target_lemma_id:
                            if token['head'] == 0:
                                # Root relation
                                relation_operations.append({
                                    'relation_layer_id': relation_layer['id'],
                                    'source': target_lemma_id,
                                    'target': target_lemma_id,
                                    'value': token['deprel']
                                })
                            else:
                                # Regular relation
                                head_idx = token['head'] - 1  # Convert to 0-based
                                if 0 <= head_idx < len(sentence_lemma_ids):
                                    source_lemma_id = sentence_lemma_ids[head_idx]
                                    if source_lemma_id:
                                        relation_operations.append({
                                            'relation_layer_id': relation_layer['id'],
                                            'source': source_lemma_id,
                                            'target': target_lemma_id,
                                            'value': token['deprel']
                                        })
                
                if relation_operations:
                    client.relations.bulk_create(relation_operations)
                    print(f"Created {len(relation_operations)} dependency relations")
        
        print(f"Successfully parsed document {document_id}")
        return True
        
    except Exception as e:
        print(f"Error parsing document {document_id}: {e}")
        raise(e)


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

    pipeline = stanza.Pipeline(
            'en',
            processors='tokenize,pos,lemma,depparse',
            download_method=stanza.DownloadMethod.REUSE_RESOURCES)
    
    def on_event(event_type, event_data):
        print(f"Received event. Type: {event_type}.\nPayload: {event_data}")
        
        if event_type == "message":
            # Handle messages from clients
            message_body = event_data.get("data", {})
            project_id = event_data.get("project")
            
            if message_body == "nlp-wake-check":
                print(f"Received wake-check from project {project_id}")
                client.messages.send_message(project_id, "nlp-awake")
                
            elif message_body.startswith("parse-document:"):
                document_id = message_body.split(":", 1)[1]
                print(f"Received parse request for document {document_id} in project {project_id}")
                
                try:
                    # Get document content
                    document = client.documents.get(document_id, True)
                    text_layer = document.get('text_layers', [{}])[0] if document.get('text_layers') else None

                    if not text_layer:
                        client.messages.send_message(project_id, f"parse-error:{document_id}:No text layer found")
                        return

                    text = text_layer.get('text')
                    if not text:
                        client.messages.send_message(project_id, f"parse-error:{document_id}:No text content found")
                        return

                    text_content = text.get('body', '')
                    if not text_content.strip():
                        client.messages.send_message(project_id, f"parse-error:{document_id}:Text content is empty")
                        return

                    # Send parsing started message
                    client.messages.send_message(project_id, f"parse-started:{document_id}")

                    # Perform the parse
                    success = parse_document(pipeline, client, document_id, text_content)

                    # Send completion message
                    if success:
                        client.messages.send_message(project_id, f"parse-success:{document_id}")
                    else:
                        client.messages.send_message(project_id, f"parse-error:{document_id}:Parsing failed")

                except Exception as e:
                    print(f"Error during parse: {str(e)}")
                    client.messages.send_message(project_id, f"parse-error:{document_id}:{e}")
                    raise(e)

    # Start by listening to a sample project (you can remove this hardcoded ID)
    print(f"Starting NLP service, listening to project {target_project_id}")
    connection = client.messages.listen(target_project_id, on_event)
    print("End listening")


if __name__ == '__main__':
    main()
