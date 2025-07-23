import sys
import os
import requests
import tempfile
import whisper
import argparse
import torch
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


class WhisperASR:
    def __init__(self, model_name="base", keep_loaded=True):
        """Initialize the Whisper ASR model"""
        self.model_name = model_name
        self.keep_loaded = keep_loaded
        self.model = None
        self.device = self._detect_device()
        print(f"Whisper model: {model_name} (keep_loaded={keep_loaded})")
        print(f"Detected device: {self.device}")
        
        # Load model immediately if keep_loaded is True
        if self.keep_loaded:
            self.load_model()
    
    def _detect_device(self):
        """Detect the best available device for Whisper"""
        if torch.cuda.is_available():
            device = f"cuda:{torch.cuda.current_device()}"
            gpu_name = torch.cuda.get_device_name(torch.cuda.current_device())
            print(f"CUDA available: GPU {gpu_name}")
            return device
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            print("MPS (Apple Silicon GPU) available")
            return "mps"
        else:
            print("No GPU acceleration available, using CPU")
            return "cpu"
    
    def _verify_model_device(self):
        """Verify which device the model is actually using"""
        if self.model is not None:
            # Check if model has parameters and get their device
            try:
                model_device = next(self.model.parameters()).device
                print(f"Model is loaded on device: {model_device}")
                return str(model_device)
            except (StopIteration, AttributeError):
                print("Could not determine model device")
                return "unknown"
        return None
        
    def load_model(self):
        """Load the Whisper model"""
        if self.model is None:
            print(f"Loading Whisper {self.model_name} model on {self.device}...")
            
            # Load model and move to detected device
            self.model = whisper.load_model(self.model_name, device=self.device)
            
            # Verify the model is actually on the expected device
            actual_device = self._verify_model_device()
            
            if actual_device and actual_device.startswith('cuda'):
                # Show GPU memory usage if on CUDA
                if torch.cuda.is_available():
                    memory_allocated = torch.cuda.memory_allocated() / (1024**3)  # GB
                    memory_reserved = torch.cuda.memory_reserved() / (1024**3)   # GB
                    print(f"GPU memory: {memory_allocated:.1f}GB allocated, {memory_reserved:.1f}GB reserved")
            
            print("Whisper model loaded successfully")
    
    def unload_model(self):
        """Unload the model from memory if not keeping it loaded"""
        if not self.keep_loaded and self.model is not None:
            print("Unloading Whisper model from memory...")
            del self.model
            self.model = None
            
            # Clear GPU cache if using CUDA
            if self.device.startswith('cuda') and torch.cuda.is_available():
                torch.cuda.empty_cache()
                print("GPU cache cleared")
    
    def transcribe_with_timestamps(self, audio_path):
        """
        Transcribe audio and return segment-level timestamps using Whisper's natural segmentation
        """
        self.load_model()
        
        print(f"Transcribing audio file: {audio_path}")
        
        try:
            # Transcribe the entire file - Whisper handles chunking internally
            result = self.model.transcribe(audio_path)
            
            # Extract segments with timestamps
            transcriptions = []
            for segment in result["segments"]:
                segment_text = segment["text"].strip()
                if segment_text:  # Only include non-empty segments
                    transcriptions.append({
                        'text': segment_text,
                        'start': segment['start'],
                        'end': segment['end']
                    })
            
            # Get total duration from the result or calculate from segments
            total_duration = result.get("duration", 0)
            if not total_duration and transcriptions:
                total_duration = max(seg['end'] for seg in transcriptions)
            
            return transcriptions, total_duration
        finally:
            # Unload model if not keeping it loaded
            self.unload_model()


def download_media_file(client, media_url, temp_dir):
    """Download media file from authenticated URL"""
    try:
        # Add authentication token to the URL
        auth_url = f"{media_url}?token={client.token}"
        
        response = requests.get(auth_url, stream=True)
        response.raise_for_status()
        
        # Save to temporary file
        temp_file = os.path.join(temp_dir, f"media")
        with open(temp_file, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        return temp_file
        
    except Exception as e:
        raise Exception(f"Failed to download media file: {str(e)}")


def create_time_alignment_tokens(client, document_id, transcriptions, text_layer_id, alignment_token_layer_id, sentence_token_layer_id, response_helper):
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
            insertion_pos = find_text_insertion_position(current_text, existing_alignment_tokens, trans['start'])
            
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
                'time_end': trans['end']
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
                
                # Create alignment token
                new_alignment_tokens.append({
                    "token_layer_id": alignment_token_layer_id,
                    "text": text_id,
                    "begin": token_start,
                    "end": token_end,
                    "metadata": {
                        "timeBegin": mod['time_start'],
                        "timeEnd": mod['time_end']
                    }
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
            update_existing_token_positions(client, existing_alignment_tokens, text_modifications)
            
            # Update sentence partitioning 
            response_helper.progress(92, "Updating sentence partitioning...")
            update_sentence_partitioning(
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
            validate_temporal_ordering(all_updated_tokens)
            
            # Validate sentence partitioning invariant
            validate_sentence_partitioning(client, document, sentence_token_layer_id)
        
        return len(new_alignment_tokens)
        
    except Exception as e:
        raise Exception(f"Failed to create alignment tokens: {str(e)}")


def update_existing_token_positions(client, existing_alignment_tokens, text_modifications):
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
        token_time = token.get("metadata", {}).get("timeBegin", 0)
        
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


def validate_sentence_partitioning(client, document, sentence_token_layer_id):
    """Validate that sentence tokens maintain proper partitioning invariant
    
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


def validate_temporal_ordering(alignment_tokens):
    """Validate that alignment tokens maintain temporal ordering invariant
    
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


def update_sentence_partitioning(client, document, text_id, sentence_token_layer_id, 
                                existing_alignment_tokens, new_alignment_tokens, original_text, updated_text, text_modifications):
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
            new_sentences = create_sentences_from_alignment_tokens(
                new_alignment_tokens, text_id, sentence_token_layer_id, 
                full_text=updated_text, text_start=0, text_end=len(updated_text)
            )
        else:
            # Case 2: Insertion doesn't overlap with existing sentences
            # This could happen at document edges or in gaps between sentences
            new_sentences = create_sentences_from_alignment_tokens(
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
    
    combined_text = updated_text[safe_start:safe_end]
    combined_start = safe_start
    
    
    
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
    
    new_sentences = create_sentences_from_alignment_tokens(
        affected_alignment_tokens, text_id, sentence_token_layer_id,
        full_text=updated_text, text_start=safe_start, text_end=safe_end
    )
    
    # Create new sentence tokens
    if new_sentences:
        client.tokens.bulk_create(new_sentences)


def create_sentences_from_alignment_tokens(alignment_tokens, text_id, sentence_token_layer_id, full_text="", text_start=0, text_end=None):
    """Create sentence tokens that maintain partitioning invariant
    
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


def tokenize_new_text_as_sentences(text, start_pos, end_pos, text_id, sentence_token_layer_id):
    """Tokenize new text range as sentences"""
    text_segment = text[start_pos:end_pos]
    return tokenize_text_as_sentences(text_segment, start_pos, text_id, sentence_token_layer_id)


def tokenize_text_as_sentences(text, start_offset, text_id, sentence_token_layer_id):
    """
    Tokenize text into sentences using simple newline-based splitting.
    This mimics the logic from tokenizationUtils.js tokenizeSentences function.
    """
    if not text or not text.strip():
        return []
    
    sentences = []
    
    # Split on newline followed by optional whitespace (similar to tokenizationUtils.js)
    import re
    sentence_boundaries = list(re.finditer(r'\n\s*', text))
    
    last_end = 0
    for match in sentence_boundaries:
        if match.start() > last_end:
            sentence_text = text[last_end:match.start()]
            if sentence_text.strip():
                sentences.append({
                    "token_layer_id": sentence_token_layer_id,
                    "text": text_id,  # Reference to text ID (not text layer ID)
                    "begin": start_offset + last_end,
                    "end": start_offset + match.start()
                })
        last_end = match.end()
    
    # Handle final sentence
    if last_end < len(text):
        sentence_text = text[last_end:]
        if sentence_text.strip():
            sentences.append({
                "token_layer_id": sentence_token_layer_id,
                "text": text_id,  # Reference to text ID (not text layer ID)
                "begin": start_offset + last_end,
                "end": start_offset + len(text)
            })
    
    return sentences


def find_text_insertion_position(current_text, existing_alignment_tokens, target_time):
    """Find the best position in text to insert a word based on its timestamp
    
    This function ensures temporal ordering: if token A has timeBegin < token B's timeBegin,
    then A's text position will be < B's text position.
    """
    
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




def process_asr(client, document_id, text_layer_id, alignment_token_layer_id, sentence_token_layer_id, response_helper, asr_instance):
    """Process ASR and create time alignment tokens"""
    temp_dir = tempfile.mkdtemp()
    
    try:
        # Acquire document lock since we'll be modifying text and tokens
        response_helper.progress(2, "Acquiring document lock...")
        client.documents.acquire_lock(document_id)
        # Get document to fetch media URL
        response_helper.progress(5, "Fetching document...")
        full_document = client.documents.get(document_id, True)
        
        # Get media URL from document
        media_url = full_document.get("media_url")
        if not media_url:
            raise ValueError("No media file attached to document")
        
        # Construct full media URL if it's a relative path
        if media_url.startswith('/'):
            # Remove trailing slash from base URL if present, then add the media URL
            base_url = client.base_url.rstrip('/')
            full_media_url = f"{base_url}{media_url}"
        else:
            full_media_url = media_url
        
        # Download media file
        response_helper.progress(10, "Downloading media file...")
        audio_file = download_media_file(client, full_media_url, temp_dir)
        
        # Analyze document structure
        response_helper.progress(20, "Analyzing document structure...")
        
        # Use provided layer IDs directly - they're already validated by the client
        
        # Transcribe audio with Whisper
        response_helper.progress(30, "Loading Whisper model...")
        response_helper.progress(40, "Transcribing audio with Whisper...")
        transcriptions, duration = asr_instance.transcribe_with_timestamps(audio_file)
        
        if not transcriptions:
            raise ValueError("No transcription results generated")
        
        response_helper.progress(70, f"Generated {len(transcriptions)} segment alignments...")
        
        # Create time alignment tokens (preserve existing ones)
        tokens_created = create_time_alignment_tokens(
            client, document_id, transcriptions, text_layer_id, alignment_token_layer_id, sentence_token_layer_id, response_helper
        )
        
        response_helper.progress(100, "ASR processing completed successfully")
        response_helper.complete({
            "documentId": document_id,
            "status": "success",
            "tokensCreated": tokens_created,
            "duration": duration,
            "segmentsTranscribed": len(transcriptions)
        })
        
    except Exception as e:
        import traceback
        print(f"Error during ASR processing: {str(e)}")
        response_helper.error(f"ASR processing error: {str(e)}")
        traceback.print_exc()
    finally:
        # Always release document lock
        try:
            client.documents.release_lock(document_id)
        except Exception as lock_error:
            print(f"Failed to release document lock: {lock_error}")
        
        # Clean up temporary files
        try:
            import shutil
            shutil.rmtree(temp_dir)
        except Exception as cleanup_error:
            print(f"Failed to clean up temporary files: {cleanup_error}")


def main():
    parser = argparse.ArgumentParser(description='Whisper ASR Service for Plaid')
    parser.add_argument('project_id', help='Target project ID')
    parser.add_argument('--url', default='http://localhost:8085', help='Plaid API URL (default: http://localhost:8085)')
    parser.add_argument('--model', default='large', choices=['tiny', 'base', 'small', 'medium', 'large'], 
                       help='Whisper model size (default: large)')
    parser.add_argument('--no-keep-loaded', action='store_true', 
                       help='Unload model from memory after each transcription (saves memory but slower)')
    parser.add_argument('--check-gpu', action='store_true',
                       help='Check GPU availability and exit')
    
    args = parser.parse_args()
    
    # Handle GPU check mode
    if args.check_gpu:
        print("=== GPU Availability Check ===")
        if torch.cuda.is_available():
            print(f"✓ CUDA is available")
            print(f"  GPU count: {torch.cuda.device_count()}")
            for i in range(torch.cuda.device_count()):
                print(f"  GPU {i}: {torch.cuda.get_device_name(i)}")
                print(f"    Memory: {torch.cuda.get_device_properties(i).total_memory / (1024**3):.1f}GB")
        else:
            print("✗ CUDA is not available")
        
        if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            print("✓ MPS (Apple Silicon GPU) is available")
        else:
            print("✗ MPS is not available")
        
        print(f"PyTorch version: {torch.__version__}")
        return
    
    client = get_client(args.url)
    client.set_agent_name("Whisper ASR")
    target_project_id = args.project_id
    
    # Create ASR instance with specified options
    keep_loaded = not args.no_keep_loaded
    asr_instance = WhisperASR(model_name=args.model, keep_loaded=keep_loaded)
    
    # Track if a request is currently being processed
    processing_lock = {"is_processing": False}
    
    try:
        client.projects.get(target_project_id)
    except requests.exceptions.HTTPError as e:
        print(f"Invalid project ID {target_project_id}: {e}", file=sys.stderr)
        sys.exit(1)

    def handle_service_request(request_data, response_helper):
        """Handle structured service requests for ASR processing"""
            
        # Check if another request is already being processed
        if processing_lock["is_processing"]:
            response_helper.error("ASR service is currently processing another request. Please try again later.")
            return
        
        document_id = request_data.get('documentId')
        text_layer_id = request_data.get('textLayerId')
        alignment_token_layer_id = request_data.get('alignmentTokenLayerId')
        sentence_token_layer_id = request_data.get('sentenceTokenLayerId')
        
        if not document_id:
            response_helper.error("Missing required parameter: documentId")
            return
        
        if not text_layer_id:
            response_helper.error("Missing required parameter: textLayerId")
            return
        
        if not alignment_token_layer_id:
            response_helper.error("Missing required parameter: alignmentTokenLayerId")
            return
        
        # sentence_token_layer_id is optional for backward compatibility
        
        # Set processing lock before starting
        processing_lock["is_processing"] = True
        
        try:
            process_asr(client, document_id, text_layer_id, alignment_token_layer_id, sentence_token_layer_id, response_helper, asr_instance)
        finally:
            # Always clear the processing lock when done
            processing_lock["is_processing"] = False

    # Register as a structured service
    service_info = {
        'serviceId': 'asr:whisper-asr',
        'serviceName': 'Whisper ASR',
        'description': f'Automatic Speech Recognition using OpenAI\'s Whisper {args.model} model with segment-level time alignments (keep_loaded={keep_loaded})'
    }
    
    print(f"Registering as service: {service_info}")
    print(f"Starting ASR service, listening to project {target_project_id}")
    
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
