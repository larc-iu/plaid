"""
Token Processor

Handles the complex logic of managing tokens in Plaid documents including
collision detection, boundary management, cross-sentence splitting, and
batch operations.
"""

from typing import List, Dict, Any, Optional
from .tokenizer_model import TokenSpan


class TokenProcessor:
    """
    Core engine for processing tokenization results and updating Plaid documents.
    
    Handles all the complex logic around:
    - Token collision detection and merging
    - Cross-sentence token splitting
    - Batch operations with Plaid API
    - Token position management
    - Sentence boundary handling
    """
    
    def __init__(self):
        """Initialize the token processor."""
        pass
    
    def process_tokens(self, client, document_id: str, sentences: List[TokenSpan], words: List[TokenSpan],
                      primary_token_layer_id: str, sentence_layer_id: Optional[str], response_helper) -> Dict[str, int]:
        """
        Process tokenization results and update the Plaid document.
        
        Args:
            client: PlaidClient instance
            document_id: ID of document to update
            sentences: List of sentence TokenSpan objects
            words: List of word TokenSpan objects
            primary_token_layer_id: ID of primary token layer for words
            sentence_layer_id: Optional ID of sentence token layer
            response_helper: Helper for progress updates
            
        Returns:
            Dictionary with counts of tokens created/deleted
        """
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
                return {"tokensCreated": 0, "tokensDeleted": 0, "sentencesCreated": 0}
            
            # Get existing tokens
            response_helper.progress(20, "Analyzing existing tokens...")
            primary_layer = None
            sentence_layer = None
            
            for tl in text_layer["token_layers"]:
                if tl["id"] == primary_token_layer_id:
                    primary_layer = tl
                elif sentence_layer_id and tl["id"] == sentence_layer_id:
                    sentence_layer = tl
            
            if not primary_layer:
                response_helper.error("Primary token layer not found")
                return {"tokensCreated": 0, "tokensDeleted": 0, "sentencesCreated": 0}
            
            existing_tokens = primary_layer.get("tokens", [])
            existing_sentences = sentence_layer.get("tokens", []) if sentence_layer else []
            
            # Convert TokenSpan objects to the format expected by existing functions
            response_helper.progress(30, "Processing tokenization results...")
            new_sentences_dict = [{'begin': s.start, 'end': s.end, 'text': s.text} for s in sentences]
            new_words_dict = [{'begin': w.start, 'end': w.end, 'text': w.text} for w in words]
            
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
                existing_tokens_split = self._split_cross_sentence_tokens(
                    [{'begin': t['begin'], 'end': t['end'], 'id': t.get('id')} for t in existing_tokens],
                    existing_sentence_boundaries
                )
                
                # Find tokens that were actually split
                for orig_token in existing_tokens:
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
            new_words_split = self._split_cross_sentence_tokens(
                [{'begin': w['begin'], 'end': w['end']} for w in new_words_dict],
                existing_sentence_boundaries
            )
            
            response_helper.progress(40, "Merging tokens...")
            words_to_create = self._merge_with_existing_tokens(new_words_split, split_existing_tokens)
            
            # Handle sentence tokenization (only if exactly one existing sentence)
            should_do_sentences = sentence_layer and self._should_tokenize_sentences(existing_sentences)
            sentences_to_create = []
            existing_sentence_to_delete = None
            
            if should_do_sentences:
                response_helper.progress(45, "Processing sentence tokenization...")
                existing_sentence_to_delete = existing_sentences[0]['id']
                sentences_to_create = [{'begin': s['begin'], 'end': s['end']} for s in new_sentences_dict]
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
                    
                    client.tokens.bulk_create(token_operations)
                    response_helper.progress(90, f"Created {len(token_operations)} tokens...")
                
                response_helper.progress(95, "Committing changes...")
                client.submit_batch()
            
            return {
                "tokensCreated": len(words_to_create) if words_to_create else 0,
                "tokensDeleted": tokens_deleted,
                "sentencesCreated": sentences_created
            }
            
        except Exception as e:
            raise Exception(f"Failed to process tokens: {str(e)}")
    
    def _should_tokenize_sentences(self, existing_sentences: List[Dict]) -> bool:
        """Check if we should tokenize sentences based on existing sentence count"""
        return len(existing_sentences) == 1
    
    def _split_cross_sentence_tokens(self, tokens: List[Dict], sentences: List[Dict]) -> List[Dict]:
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
    
    def _merge_with_existing_tokens(self, new_tokens: List[Dict], existing_tokens: List[Dict]) -> List[Dict]:
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