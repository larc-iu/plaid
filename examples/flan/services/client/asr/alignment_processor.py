"""
Alignment Processor

Handles the complex logic of inserting ASR alignments into Plaid documents
while managing text insertion, collision detection, position updates, and
sentence partitioning.
"""

import os
import requests
import tempfile
import re
from typing import List, Dict, Any, Optional, Tuple
from .asr_model import Alignment


class AlignmentProcessor:
    """
    Core engine for processing ASR alignments and updating Plaid documents.
    
    Handles all the complex logic around:
    - Media file downloading
    - Collision detection with existing tokens
    - Text insertion with temporal ordering
    - Position updates for existing tokens
    - Sentence partitioning maintenance
    - Validation of invariants
    """
    
    def __init__(self):
        """
        Initialize the alignment processor. No options for now.
        """

    def process_alignments(self, client, document_id: str, alignments: List[Alignment],
                          text_layer_id: str, alignment_token_layer_id: str,
                          sentence_token_layer_id: Optional[str], response_helper) -> int:
        """
        Process ASR alignments and update the Plaid document.
        
        Args:
            client: PlaidClient instance
            document_id: ID of document to update
            alignments: List of Alignment objects from ASR
            text_layer_id: ID of text layer to update
            alignment_token_layer_id: ID of token layer for alignment tokens
            sentence_token_layer_id: Optional ID of sentence token layer
            response_helper: Helper for progress updates
            
        Returns:
            Number of new alignment tokens created
        """
        try:
            # Acquire document lock since we'll be modifying text and tokens
            response_helper.progress(2, "Acquiring document lock...")
            client.documents.acquire_lock(document_id)
            
            # Convert alignments to transcription format
            transcriptions = [
                {
                    'text': alignment.text,
                    'start': alignment.start,
                    'end': alignment.end,
                    'metadata': alignment.metadata
                }
                for alignment in alignments
            ]
            
            # Create time alignment tokens (preserve existing ones)
            tokens_created = self._create_time_alignment_tokens(
                client, document_id, transcriptions, text_layer_id, 
                alignment_token_layer_id, sentence_token_layer_id, response_helper
            )
            
            return tokens_created
            
        finally:
            # Always release document lock
            try:
                client.documents.release_lock(document_id)
            except Exception as lock_error:
                print(f"Failed to release document lock: {lock_error}")
    
    def download_media_file(self, client, media_url: str, temp_dir: str) -> str:
        """
        Download media file from authenticated URL.
        
        Args:
            client: PlaidClient instance with authentication
            media_url: URL of media file to download
            temp_dir: Temporary directory for downloaded file
            
        Returns:
            Path to downloaded file
            
        Raises:
            Exception: If download fails
        """
        try:
            # Add authentication token to the URL
            auth_url = f"{media_url}?token={client.token}"
            
            response = requests.get(auth_url, stream=True)
            response.raise_for_status()
            
            # Save to temporary file
            temp_file = os.path.join(temp_dir, "media")
            with open(temp_file, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            return temp_file
            
        except Exception as e:
            raise Exception(f"Failed to download media file: {str(e)}")
    
    def _create_time_alignment_tokens(self, client, document_id: str, transcriptions: List[Dict],
                                     text_layer_id: str, alignment_token_layer_id: str,
                                     sentence_token_layer_id: Optional[str], response_helper) -> int:
        """Create time alignment tokens from transcription results, preserving existing work"""
        try:
            # Get document with full token information
            response_helper.progress(75, "Analyzing existing tokens and text...")
            document = client.documents.get(document_id, True)
            
            # Find text layer and existing tokens
            text_layer = None
            alignment_token_layer = None
            
            for tl in document["text_layers"]:
                if tl["id"] == text_layer_id:
                    text_layer = tl
                    # Find token layers within this text layer
                    for token_layer in tl.get("token_layers", []):
                        if token_layer["id"] == alignment_token_layer_id:
                            alignment_token_layer = token_layer
                            break
                    break
            
            if not text_layer:
                raise ValueError("Text layer not found")
            
            # Get existing alignment tokens
            existing_alignment_tokens = sorted(
                alignment_token_layer.get("tokens", []) if alignment_token_layer else [],
                key=lambda t: t.get("metadata", {}).get("timeBegin", 0)
            )
            
            # Get current text content
            current_text = text_layer.get("text", {}).get("body", "")
            text_id = text_layer.get("text", {}).get("id")
            
            if not text_id:
                # Create initial text if none exists
                text_result = client.texts.create(text_layer_id, document_id, "")
                text_id = text_result["id"]
                current_text = ""
            
            response_helper.progress(78, "Filtering transcriptions to avoid time collisions...")
            
            # Step 1: Filter out transcriptions that have time collisions
            non_colliding_transcriptions = []
            for trans in transcriptions:
                trans_start = trans['start']
                trans_end = trans['end']
                
                # Check for time overlap with existing alignment tokens
                has_collision = False
                for existing_token in existing_alignment_tokens:
                    existing_start = existing_token.get("metadata", {}).get("timeBegin", 0)
                    existing_end = existing_token.get("metadata", {}).get("timeEnd", 0)
                    
                    # Check for overlap: not (trans_end <= existing_start or trans_start >= existing_end)
                    if not (trans_end <= existing_start or trans_start >= existing_end):
                        has_collision = True
                        break
                
                if not has_collision:
                    non_colliding_transcriptions.append(trans)
            
            response_helper.progress(82, f"Processing {len(non_colliding_transcriptions)} non-colliding transcriptions...")
            
            # Step 2 & 3: For each non-colliding transcription, update text and create tokens
            new_alignment_tokens = []
            
            # We'll need to track text changes to update positions correctly
            text_modifications = []  # List of (position, old_length, new_text) tuples
            
            for i, trans in enumerate(non_colliding_transcriptions):
                segment_text = trans['text'].strip()
                if not segment_text:
                    continue
                
                # Find insertion point in text based on time
                insertion_pos = self._find_text_insertion_position(current_text, existing_alignment_tokens, trans['start'])
                
                # Add space at the end of all segments except the final one
                is_final_segment = (i == len(non_colliding_transcriptions) - 1)
                if is_final_segment:
                    new_segment_text = segment_text
                else:
                    new_segment_text = segment_text + " "
                
                # Track this modification
                text_modifications.append({
                    'position': insertion_pos,
                    'old_length': 0,
                    'new_text': new_segment_text,
                    'segment_start_offset': 0,  # Segment always starts at insertion point
                    'segment_length': len(segment_text),  # Token length is just the segment text
                    'time_start': trans['start'],
                    'time_end': trans['end'],
                    'metadata': trans.get('metadata', {})
                })
            
            # Apply text modifications and create tokens
            if text_modifications:
                response_helper.progress(85, "Applying text changes and creating tokens...")
                
                # Sort modifications by position (forward order for sequential application)
                text_modifications.sort(key=lambda m: m['position'])
                
                # Apply modifications sequentially and track cumulative offset
                new_text = current_text
                cumulative_offset = 0
                
                for mod in text_modifications:
                    # Calculate actual insertion position with cumulative offset
                    actual_pos = mod['position'] + cumulative_offset
                    
                    # Insert the segment text
                    new_text = new_text[:actual_pos] + mod['new_text'] + new_text[actual_pos:]
                    
                    # Calculate token positions in the final text
                    token_start = actual_pos + mod['segment_start_offset']
                    token_end = token_start + mod['segment_length']
                    
                    # Create alignment token with metadata
                    token_metadata = {
                        "timeBegin": mod['time_start'],
                        "timeEnd": mod['time_end']
                    }
                    token_metadata.update(mod['metadata'])  # Add any model-specific metadata
                    
                    new_alignment_tokens.append({
                        "token_layer_id": alignment_token_layer_id,
                        "text": text_id,
                        "begin": token_start,
                        "end": token_end,
                        "metadata": token_metadata
                    })
                    
                    # Update cumulative offset for next insertion
                    cumulative_offset += len(mod['new_text'])
                
                # Begin atomic batch operation
                response_helper.progress(88, "Committing changes...")
                client.begin_batch()
                
                # Update the text
                client.texts.update(text_id, new_text)
                
                # Create alignment tokens
                if new_alignment_tokens:
                    response_helper.progress(90, f"Creating {len(new_alignment_tokens)} alignment tokens...")
                    client.tokens.bulk_create(new_alignment_tokens)
                
                # Update positions of existing alignment tokens affected by text insertion
                response_helper.progress(91, "Updating existing token positions...")
                self._update_existing_token_positions(client, existing_alignment_tokens, text_modifications)
                
                # Update sentence partitioning 
                if sentence_token_layer_id:
                    response_helper.progress(92, "Updating sentence partitioning...")
                    self._update_sentence_partitioning(
                        client, document, text_id, sentence_token_layer_id,
                        existing_alignment_tokens, new_alignment_tokens, current_text, new_text, text_modifications
                    )
                
                # Submit all changes atomically
                response_helper.progress(95, "Submitting batch...")
                client.submit_batch()
                
                # Validate temporal ordering invariant - need to get updated tokens from database
                response_helper.progress(98, "Validating temporal ordering...")
                # Re-fetch the document to get updated token positions for validation
                updated_document = client.documents.get(document_id, True)
                all_updated_tokens = []
                for tl in updated_document["text_layers"]:
                    for token_layer in tl.get("token_layers", []):
                        if token_layer["id"] == alignment_token_layer_id:
                            all_updated_tokens = token_layer.get("tokens", [])
                            break
                self._validate_temporal_ordering(all_updated_tokens)
                
                # Validate sentence partitioning invariant
                self._validate_sentence_partitioning(client, document, sentence_token_layer_id)
            
            return len(new_alignment_tokens)
            
        except Exception as e:
            raise Exception(f"Failed to create alignment tokens: {str(e)}")
    
    def _find_text_insertion_position(self, current_text: str, existing_alignment_tokens: List[Dict], target_time: float) -> int:
        """Find the best position in text to insert a word based on its timestamp"""
        
        if not existing_alignment_tokens:
            return len(current_text)

        # Sort existing tokens by time to ensure proper temporal ordering
        tokens_by_time = sorted(existing_alignment_tokens, key=lambda t: t.get("metadata", {}).get("timeBegin", 0))
        
        # Find the position based on temporal ordering
        for i, token in enumerate(tokens_by_time):
            token_time = token.get("metadata", {}).get("timeBegin", 0)
            
            if target_time < token_time:
                # Insert before this token temporally
                # We need to find the correct position that maintains temporal ordering
                if i == 0:
                    # Insert at the beginning of text if this is the first token temporally
                    return 0
                else:
                    # Insert after the previous token (temporally)
                    # But we need to ensure we don't violate ordering with the current token
                    prev_token = tokens_by_time[i - 1]
                    current_token = token
                    
                    # If the current token's position is before the previous token's end,
                    # we need to insert before the current token instead
                    if current_token["begin"] < prev_token["end"]:
                        print(f"WARNING: Temporal ordering conflict detected. Inserting before conflicting token.")
                        return current_token["begin"]
                    else:
                        return prev_token["end"]
        
        # If we get here, insert after the last token (temporally)
        last_token = tokens_by_time[-1]
        return last_token["end"]
    
    def _update_existing_token_positions(self, client, existing_alignment_tokens: List[Dict], text_modifications: List[Dict]):
        """
        Update the positions of existing alignment tokens after text insertions.
        
        When text is inserted, existing tokens that come after the insertion points
        need their begin/end positions adjusted to account for the inserted text.
        """
        if not existing_alignment_tokens or not text_modifications:
            return
        
        tokens_to_update = []
        
        for token in existing_alignment_tokens:
            token_begin = token.get("begin", 0)
            token_end = token.get("end", 0)
            
            # Calculate adjustment by looking at all modifications that happened before this token's ORIGINAL position
            adjustment = 0
            
            for mod in text_modifications:
                # mod['position'] is the position where text was inserted in the ORIGINAL text
                original_insertion_pos = mod['position']
                insertion_length = len(mod['new_text'])
                
                # If the insertion happened before this token's original position, adjust this token
                if original_insertion_pos <= token_begin:
                    adjustment += insertion_length
            
            # If this token needs adjustment, prepare the update
            if adjustment > 0:
                new_begin = token_begin + adjustment
                new_end = token_end + adjustment
                
                # Prepare token update
                tokens_to_update.append({
                    "id": token["id"],
                    "begin": new_begin,
                    "end": new_end
                })
        
        # Update tokens in batch
        if tokens_to_update:
            for token_update in tokens_to_update:
                # Update individual token positions
                client.tokens.update(token_update["id"], begin=token_update["begin"], end=token_update["end"])
    
    def _validate_temporal_ordering(self, alignment_tokens: List[Dict]):
        """
        Validate that alignment tokens maintain temporal ordering invariant
        
        Ensures that for any two tokens A and B:
        if A.timeBegin < B.timeBegin then A.begin < B.begin
        """
        if len(alignment_tokens) < 2:
            return  # Nothing to validate
        
        # Sort by time to check against position ordering
        tokens_by_time = sorted(alignment_tokens, key=lambda t: t.get("metadata", {}).get("timeBegin", 0))
        
        # Check that text positions also increase with time
        for i in range(len(tokens_by_time) - 1):
            current_token = tokens_by_time[i]
            next_token = tokens_by_time[i + 1]
            
            current_time = current_token.get("metadata", {}).get("timeBegin", 0)
            next_time = next_token.get("metadata", {}).get("timeBegin", 0)
            
            current_pos = current_token.get("begin", 0)
            next_pos = next_token.get("begin", 0)
            
            if current_time < next_time and current_pos >= next_pos:
                # Temporal ordering violated
                print(f"WARNING: Temporal ordering invariant violated!")
                print(f"  Token 1: time={current_time}, pos={current_pos}, text='{current_token.get('text', '')}'")
                print(f"  Token 2: time={next_time}, pos={next_pos}, text='{next_token.get('text', '')}'")
                print(f"  Expected: time1 < time2 implies pos1 < pos2, but got pos1 >= pos2")
    
    def _validate_sentence_partitioning(self, client, document: Dict, sentence_token_layer_id: str):
        """
        Validate that sentence tokens maintain proper partitioning invariant
        
        Ensures that sentences:
        1. Do not overlap with each other
        2. Are properly ordered by position
        """
        if not sentence_token_layer_id:
            return  # Skip validation if no sentence layer
        
        try:
            # Find sentence tokens (document already fetched)
            sentence_tokens = []
            for tl in document["text_layers"]:
                for token_layer in tl.get("token_layers", []):
                    if token_layer["id"] == sentence_token_layer_id:
                        sentence_tokens = token_layer.get("tokens", [])
                        break
            
            if len(sentence_tokens) < 2:
                return  # Nothing to validate
            
            # Sort by position
            sorted_sentences = sorted(sentence_tokens, key=lambda s: s.get("begin", 0))
            
            # Check for overlaps and proper ordering
            for i in range(len(sorted_sentences) - 1):
                current = sorted_sentences[i]
                next_sentence = sorted_sentences[i + 1]
                
                current_end = current.get("end", 0)
                next_start = next_sentence.get("begin", 0)
                
                if current_end > next_start:
                    print(f"WARNING: Sentence partitioning invariant violated!")
                    print(f"  Sentence 1: pos={current.get('begin', 0)}-{current_end}")
                    print(f"  Sentence 2: pos={next_start}-{next_sentence.get('end', 0)}")
                    print(f"  Sentences overlap by {current_end - next_start} characters")
            
        except Exception as e:
            print(f"Error during sentence validation: {e}")
    
    def _update_sentence_partitioning(self, client, document: Dict, text_id: str, sentence_token_layer_id: str,
                                     existing_alignment_tokens: List[Dict], new_alignment_tokens: List[Dict],
                                     original_text: str, updated_text: str, text_modifications: List[Dict]):
        """
        Update sentence partitioning after ASR text insertion.
        
        When new ASR text is inserted, existing sentence boundaries may be broken.
        This function:
        1. Identifies sentences that overlap with the insertion range
        2. Deletes affected sentences 
        3. Re-tokenizes the combined text into proper sentences
        4. Creates new sentence tokens
        """
        if not sentence_token_layer_id:
            print("No sentence token layer provided, skipping sentence partitioning")
            return
        
        # Find sentence token layer (document already fetched)  
        sentence_token_layer = None
        for tl in document["text_layers"]:
            # Find the text layer that contains our text_id
            if tl.get("text", {}).get("id") == text_id:
                for token_layer in tl.get("token_layers", []):
                    if token_layer["id"] == sentence_token_layer_id:
                        sentence_token_layer = token_layer
                        break
                break
        
        if not sentence_token_layer:
            return
        
        # Get existing sentence tokens
        existing_sentence_tokens = sentence_token_layer.get("tokens", [])
        
        # Find insertion range based on new alignment tokens
        if not new_alignment_tokens:
            return
        
        # Find the range of text affected by new insertions
        new_token_starts = [t["begin"] for t in new_alignment_tokens]
        new_token_ends = [t["end"] for t in new_alignment_tokens] 
        insertion_start = min(new_token_starts)
        insertion_end = max(new_token_ends)
        
        # Find sentences that overlap with the insertion range
        affected_sentences = []
        for sentence in existing_sentence_tokens:
            sentence_start = sentence.get("begin", 0)
            sentence_end = sentence.get("end", 0)
            
            # Check for overlap: not (sentence_end <= insertion_start or sentence_start >= insertion_end)
            if not (sentence_end <= insertion_start or sentence_start >= insertion_end):
                affected_sentences.append(sentence)
        
        # If no sentences are affected, we need to handle edge cases
        if not affected_sentences:
            # Handle different edge cases:
            if not existing_sentence_tokens:
                # Case 1: No existing sentences at all - create sentences from alignment tokens
                new_sentences = self._create_sentences_from_alignment_tokens(
                    new_alignment_tokens, text_id, sentence_token_layer_id, 
                    full_text=updated_text, text_start=0, text_end=len(updated_text)
                )
            else:
                # Case 2: Insertion doesn't overlap with existing sentences
                # This could happen at document edges or in gaps between sentences
                new_sentences = self._create_sentences_from_alignment_tokens(
                    new_alignment_tokens, text_id, sentence_token_layer_id,
                    full_text=updated_text, text_start=insertion_start, text_end=insertion_end
                )
            
            if new_sentences:
                client.tokens.bulk_create(new_sentences)
            return
        
        # Find the full range that needs to be re-tokenized
        # This should extend from the earliest affected sentence to the latest
        affected_start = min(s.get("begin", 0) for s in affected_sentences)
        affected_end = max(s.get("end", 0) for s in affected_sentences)
        
        # Since text insertion has happened, we need to adjust the end position
        # The insertion added (insertion_end - insertion_start) characters
        insertion_length = insertion_end - insertion_start
        
        # Calculate the adjusted end position in the updated text
        if affected_end > insertion_start:
            # Sentences extended beyond the insertion point
            adjusted_end = affected_end + insertion_length
        else:
            # All affected sentences were before the insertion point (shouldn't happen due to overlap detection)
            adjusted_end = affected_end
        
        # Extract the text that needs to be re-tokenized from the UPDATED text
        # Handle edge cases where range might be invalid
        text_length = len(updated_text)
        
        # Ensure we don't go beyond text boundaries
        safe_start = max(0, affected_start)
        safe_end = min(text_length, adjusted_end)
        
        if safe_start >= safe_end:
            print("Warning: Invalid text range for sentence re-tokenization, skipping")
            return
        
        # Delete affected sentences
        if affected_sentences:
            sentence_ids_to_delete = [s["id"] for s in affected_sentences if "id" in s]
            if sentence_ids_to_delete:
                for sentence_id in sentence_ids_to_delete:
                    client.tokens.delete(sentence_id)
        
        # Re-tokenize: we need to be more careful about existing vs new alignment tokens
        # Get all alignment tokens with updated positions for the affected range
        updated_existing_tokens = []
        for token in existing_alignment_tokens:
            # Calculate the updated position for existing tokens
            token_begin = token.get("begin", 0)
            adjustment = sum(len(mod['new_text']) for mod in text_modifications 
                            if mod['position'] <= token_begin)
            updated_token = dict(token)
            updated_token["begin"] = token_begin + adjustment
            updated_token["end"] = token.get("end", 0) + adjustment
            updated_existing_tokens.append(updated_token)
        
        # Combine updated existing tokens with new tokens
        all_alignment_tokens = updated_existing_tokens + new_alignment_tokens
        
        # Filter to affected range
        affected_alignment_tokens = [
            token for token in all_alignment_tokens
            if token.get("begin", 0) >= safe_start and token.get("end", 0) <= safe_end
        ]
        
        new_sentences = self._create_sentences_from_alignment_tokens(
            affected_alignment_tokens, text_id, sentence_token_layer_id,
            full_text=updated_text, text_start=safe_start, text_end=safe_end
        )
        
        # Create new sentence tokens
        if new_sentences:
            client.tokens.bulk_create(new_sentences)
    
    def _create_sentences_from_alignment_tokens(self, alignment_tokens: List[Dict], text_id: str, 
                                               sentence_token_layer_id: str, full_text: str = "",
                                               text_start: int = 0, text_end: Optional[int] = None) -> List[Dict]:
        """
        Create sentence tokens that maintain partitioning invariant
        
        Creates sentences that span from one alignment token to the next,
        ensuring all characters in the text range are covered by exactly one sentence.
        """
        if not alignment_tokens:
            return []
        
        # Sort alignment tokens by position
        sorted_tokens = sorted(alignment_tokens, key=lambda t: t["begin"])
        sentences = []
        
        # If we have full text info, use it for proper partitioning
        if full_text and text_end is None:
            text_end = len(full_text)
        
        # Create sentences that span from token to token
        for i, token in enumerate(sorted_tokens):
            if i == 0:
                # First sentence: from text start to end of first token
                sentence_start = text_start
            else:
                # Subsequent sentences: from end of previous token to end of current token
                sentence_start = sorted_tokens[i-1]["end"]
            
            sentence_end = token["end"]
            
            sentences.append({
                "token_layer_id": sentence_token_layer_id,
                "text": text_id,
                "begin": sentence_start,
                "end": sentence_end
            })
        
        # If we have text_end info, create final sentence from last token to text end
        if text_end is not None and sorted_tokens:
            last_token_end = sorted_tokens[-1]["end"]
            if last_token_end < text_end:
                sentences.append({
                    "token_layer_id": sentence_token_layer_id,
                    "text": text_id,
                    "begin": last_token_end,
                    "end": text_end
                })
        
        return sentences