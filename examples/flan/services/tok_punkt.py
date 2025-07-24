import sys
import nltk
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


def tokenize_with_punkt(text):
    """Use NLTK's Punkt tokenizer to tokenize text into sentences and words"""
    try:
        punkt_sent = nltk.data.load('tokenizers/punkt/english.pickle')
    except LookupError:
        print("Downloading NLTK punkt tokenizer...")
        nltk.download('punkt')
        punkt_sent = nltk.data.load('tokenizers/punkt/english.pickle')
    
    # Get raw sentence boundaries from NLTK
    raw_sentences = list(punkt_sent.span_tokenize(text))
    
    # Handle edge case: if no sentences detected, create one covering entire text
    if not raw_sentences:
        sentences = [{
            'begin': 0,
            'end': len(text),
            'text': text
        }]
    else:
        # Ensure proper partitioning by expanding sentences to fill gaps
        sentences = []
        for i, (sent_start, sent_end) in enumerate(raw_sentences):
            # Expand first sentence to start of text
            if i == 0:
                sent_start = 0
            
            # Expand each sentence to the beginning of the next sentence (or end of text)
            if i < len(raw_sentences) - 1:
                sent_end = raw_sentences[i + 1][0]  # End at start of next sentence
            else:
                sent_end = len(text)  # Last sentence goes to end of text
            
            sentences.append({
                'begin': sent_start,
                'end': sent_end,
                'text': text[sent_start:sent_end]
            })
    
    # Tokenize words within each sentence
    word_tokenizer = nltk.tokenize.TreebankWordTokenizer()
    words = []
    
    for sentence in sentences:
        sent_text = sentence['text']
        # Get word spans relative to sentence
        word_spans = list(word_tokenizer.span_tokenize(sent_text))
        
        # Convert to absolute positions
        for word_start, word_end in word_spans:
            words.append({
                'begin': sentence['begin'] + word_start,
                'end': sentence['begin'] + word_end,
                'text': sent_text[word_start:word_end]
            })
    
    return sentences, words


def should_tokenize_sentences(existing_sentences):
    """Check if we should tokenize sentences based on existing sentence count"""
    return len(existing_sentences) == 1


def split_cross_sentence_tokens(tokens, sentences):
    """Split tokens that span multiple sentences into separate tokens for each sentence"""
    if not sentences or len(sentences) <= 1:
        return tokens
    
    # Create sentence boundary lookup
    sentence_boundaries = []
    for sentence in sentences:
        sentence_boundaries.append((sentence['begin'], sentence['end']))
    sentence_boundaries.sort()  # Ensure sorted by start position
    
    split_tokens = []
    
    for token in tokens:
        token_begin = token['begin']
        token_end = token['end']
        
        # Find which sentences this token intersects with
        intersecting_sentences = []
        for sent_begin, sent_end in sentence_boundaries:
            # Check if token overlaps with this sentence
            if token_begin < sent_end and token_end > sent_begin:
                intersecting_sentences.append((sent_begin, sent_end))
        
        if len(intersecting_sentences) <= 1:
            # Token is within a single sentence, keep as is
            split_tokens.append(token)
        else:
            # Token spans multiple sentences, split it
            for sent_begin, sent_end in intersecting_sentences:
                # Calculate the intersection bounds
                split_begin = max(token_begin, sent_begin)
                split_end = min(token_end, sent_end)
                
                # Only create a token if there's actual content in this sentence
                if split_begin < split_end:
                    split_tokens.append({
                        'begin': split_begin,
                        'end': split_end
                    })
    
    return split_tokens


def merge_with_existing_tokens(new_tokens, existing_tokens):
    """Merge new tokens with existing ones, preserving existing tokens"""
    if not existing_tokens:
        return new_tokens
    
    # Sort tokens by position
    existing_sorted = sorted(existing_tokens, key=lambda t: t['begin'])
    new_sorted = sorted(new_tokens, key=lambda t: t['begin'])
    
    merged = []
    existing_idx = 0
    
    for new_token in new_sorted:
        # Skip any existing tokens that come before this new token
        while (existing_idx < len(existing_sorted) and 
               existing_sorted[existing_idx]['end'] <= new_token['begin']):
            merged.append(existing_sorted[existing_idx])
            existing_idx += 1
        
        # Check if new token overlaps with existing
        if (existing_idx < len(existing_sorted) and 
            existing_sorted[existing_idx]['begin'] < new_token['end']):
            # Skip this new token, existing token takes precedence
            continue
        else:
            # No overlap, add the new token
            merged.append(new_token)
    
    # Add any remaining existing tokens
    while existing_idx < len(existing_sorted):
        merged.append(existing_sorted[existing_idx])
        existing_idx += 1
    
    return merged


def process_tokenization(client, document_id, primary_token_layer_id, sentence_layer_id, response_helper):
    """Process document tokenization using NLTK Punkt"""
    try:
        # Get document with layers
        response_helper.progress(10, "Fetching document...")
        full_document = client.documents.get(document_id, True)
        
        # Find the text layer and content
        text_layer = full_document["text_layers"][0]
        text_id = text_layer["text"]["id"]
        text_content = text_layer["text"]["body"]
        
        if not text_content.strip():
            response_helper.error(f"Text content is empty for document {document_id}")
            return
        
        # Get existing tokens
        response_helper.progress(20, "Analyzing existing tokens...")
        primary_layer = None
        sentence_layer = None
        
        for tl in text_layer["token_layers"]:
            if tl["id"] == primary_token_layer_id:
                primary_layer = tl
            elif tl["id"] == sentence_layer_id:
                sentence_layer = tl
        
        if not primary_layer:
            response_helper.error("Primary token layer not found")
            return
        
        existing_tokens = primary_layer.get("tokens", [])
        existing_sentences = sentence_layer.get("tokens", []) if sentence_layer else []
        
        # Tokenize with NLTK
        response_helper.progress(30, "Tokenizing with NLTK Punkt...")
        new_sentences, new_words = tokenize_with_punkt(text_content)
        
        # Prepare sentence boundaries for splitting
        existing_sentence_boundaries = []
        if existing_sentences:
            existing_sentence_boundaries = [{'begin': s['begin'], 'end': s['end']} for s in existing_sentences]
        
        # Split both existing and new tokens that cross sentence boundaries
        response_helper.progress(35, "Splitting cross-sentence tokens...")
        
        # Find which existing tokens need to be deleted (those that will be split)
        tokens_to_delete = []
        split_existing_tokens = []
        
        if existing_sentence_boundaries:
            existing_tokens_split = split_cross_sentence_tokens(
                [{'begin': t['begin'], 'end': t['end'], 'id': t.get('id')} for t in existing_tokens],
                existing_sentence_boundaries
            )
            
            # Find tokens that were actually split
            original_ranges = {(t['begin'], t['end']) for t in existing_tokens}
            for orig_token in existing_tokens:
                orig_range = (orig_token['begin'], orig_token['end'])
                matching_split_tokens = [t for t in existing_tokens_split 
                                       if t['begin'] >= orig_token['begin'] and t['end'] <= orig_token['end']]
                
                if len(matching_split_tokens) > 1:  # Token was split
                    tokens_to_delete.append(orig_token['id'])
                    split_existing_tokens.extend([{'begin': t['begin'], 'end': t['end']} for t in matching_split_tokens])
                elif len(matching_split_tokens) == 1:  # Token unchanged
                    split_existing_tokens.append({'begin': orig_token['begin'], 'end': orig_token['end']})
        else:
            split_existing_tokens = [{'begin': t['begin'], 'end': t['end']} for t in existing_tokens]
        
        # Split new words and merge with split existing tokens
        new_words_split = split_cross_sentence_tokens(
            [{'begin': w['begin'], 'end': w['end']} for w in new_words],
            existing_sentence_boundaries
        )
        
        response_helper.progress(40, "Merging tokens...")
        words_to_create = merge_with_existing_tokens(new_words_split, split_existing_tokens)
        
        # Handle sentence tokenization (only if exactly one existing sentence)
        should_do_sentences = sentence_layer and should_tokenize_sentences(existing_sentences)
        sentences_to_create = []
        existing_sentence_to_delete = None
        
        if should_do_sentences:
            response_helper.progress(45, "Processing sentence tokenization...")
            existing_sentence_to_delete = existing_sentences[0]['id']
            sentences_to_create = [{'begin': s['begin'], 'end': s['end']} for s in new_sentences]
        elif sentence_layer and len(existing_sentences) != 1:
            response_helper.progress(45, "Skipping sentence tokenization (not exactly one existing sentence)...")
        
        # Filter out tokens that already exist
        existing_ranges = {(t['begin'], t['end']) for t in split_existing_tokens}
        words_to_create = [w for w in words_to_create if (w['begin'], w['end']) not in existing_ranges]
        
        # Apply changes
        response_helper.progress(50, "Applying changes...")
        
        sentences_created = 0
        tokens_deleted = len(tokens_to_delete)
        
        if words_to_create or sentences_to_create or existing_sentence_to_delete or tokens_to_delete:
            client.begin_batch()
            
            # Delete existing sentence token if we're doing sentence tokenization
            if existing_sentence_to_delete:
                client.tokens.delete(existing_sentence_to_delete)
            
            # Delete tokens that were split
            for token_id in tokens_to_delete:
                client.tokens.delete(token_id)
            
            # Create new sentence tokens
            if sentences_to_create:
                sent_operations = []
                for sent in sentences_to_create:
                    sent_operations.append({
                        "token_layer_id": sentence_layer_id,
                        "text": text_id,
                        "begin": sent['begin'],
                        "end": sent['end']
                    })
                
                client.tokens.bulk_create(sent_operations)
                sentences_created = len(sent_operations)
            
            # Create word tokens
            if words_to_create:
                token_operations = []
                for token in words_to_create:
                    token_operations.append({
                        "token_layer_id": primary_token_layer_id,
                        "text": text_id,
                        "begin": token['begin'],
                        "end": token['end']
                    })
                
                # Bulk create in chunks to avoid overwhelming the API
                chunk_size = 100
                for i in range(0, len(token_operations), chunk_size):
                    chunk = token_operations[i:i + chunk_size]
                    client.tokens.bulk_create(chunk)
                    progress = 50 + (40 * (i + len(chunk)) / len(token_operations))
                    response_helper.progress(int(progress), f"Created {i + len(chunk)} of {len(token_operations)} tokens...")
            
            response_helper.progress(95, "Committing changes...")
            client.submit_batch()
        
        response_helper.progress(100, "Tokenization completed successfully")
        response_helper.complete({
            "documentId": document_id,
            "status": "success",
            "tokensCreated": len(words_to_create) if words_to_create else 0,
            "tokensDeleted": tokens_deleted,
            "sentencesCreated": sentences_created
        })
        
    except Exception as e:
        print(f"Error during tokenization: {str(e)}")
        response_helper.error(f"Tokenization error: {str(e)}")


def main():
    if len(sys.argv) < 2:
        print("Usage: `python tok_punkt.py PROJECT_ID [URL]`", file=sys.stderr)
        sys.exit(1)
    
    client = get_client(sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8085")
    client.set_agent_name("NLTK Punkt Tokenizer")
    target_project_id = sys.argv[1]
    
    try:
        client.projects.get(target_project_id)
    except requests.exceptions.HTTPError as e:
        print(f"Invalid project ID {target_project_id}: {e}", file=sys.stderr)
        sys.exit(1)

    def handle_service_request(request_data, response_helper):
        """Handle structured service requests for document tokenization"""
        print(f"Received service request: {request_data}")
        document_id = request_data.get('documentId')
        primary_token_layer_id = request_data.get('primaryTokenLayerId')
        sentence_layer_id = request_data.get('sentenceLayerId')
        
        if not document_id or not primary_token_layer_id:
            response_helper.error("Missing required parameters: documentId and primaryTokenLayerId")
            return
        
        process_tokenization(client, document_id, primary_token_layer_id, sentence_layer_id, response_helper)

    # Register as a structured service
    service_info = {
        'serviceId': 'tok:nltk-punkt-tokenizer',
        'serviceName': 'NLTK Punkt Tokenizer',
        'description': 'Tokenizes documents into sentences and words using NLTK\'s pre-trained Punkt tokenizer'
    }
    
    print(f"Registering as service: {service_info}")
    print(f"Starting tokenization service, listening to project {target_project_id}")
    
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
