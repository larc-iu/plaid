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

from plaid_client.provenance import stamp_inferred, is_protected

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
                          sentence_token_layer_id: Optional[str], response_helper,
                          prov_source: Optional[str] = None, overwrite: bool = False) -> int:
        """
        Process ASR alignments and update the Plaid document.

        Alignment tokens are insertion-only and time-collision-aware: existing
        ones are never modified or deleted. The sentence partition, however,
        is fully reset on each pass, which cascade-deletes sentence-level
        annotations — per the provenance write contract, the run refuses when
        any of those are human-made or human-verified unless ``overwrite``.

        Args:
            client: PlaidClient instance
            document_id: ID of document to update
            alignments: List of Alignment objects from ASR
            text_layer_id: ID of text layer to update
            alignment_token_layer_id: ID of token layer for alignment tokens
            sentence_token_layer_id: Optional ID of sentence token layer
            response_helper: Helper for progress updates
            prov_source: Optional provenance producer id (e.g.
                ``service_source('<service-id>')``). When set, created tokens
                are stamped machine-made per the provenance convention.
            overwrite: Allow the sentence-partition reset to destroy
                human-made or human-verified sentence-level annotations.

        Returns:
            Number of new alignment tokens created
        """
        # Hold the document lock since we'll be modifying text and tokens; the
        # context manager acquires it (refusing with a clear error if another
        # user holds it) and always releases on exit. See
        # PlaidClient.documents.locked.
        response_helper.progress(2, "Acquiring document lock...")
        with client.documents.locked(document_id):
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
            document = client.documents.get(document_id, include_body=True)
            
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
                    if prov_source:
                        # Provenance: machine-made until a human verifies it.
                        token_metadata.update(stamp_inferred(prov_source))
                    
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

                # Build explicit insert ops rather than passing the full new_text
                # string. Passing a string would make the server run an editscript
                # diff that CAN synthesize replacement (:r) ops covering deletions;
                # if such a synthesized delete fully covered an existing sentence,
                # that sentence row would be gone by the time bulk_delete(sentence_ids)
                # ran (partitioning layers require deleting ALL or none), causing a
                # 400 and full batch rollback. ASR is insert-only by construction,
                # so emit explicit :insert directives — they cannot synthesize deletes.
                #
                # Edit ops MUST be applied left-to-right against the ORIGINAL text
                # (the server's apply-text-edits applies them in sequence and each
                # op's index is into the text as of that point). Our text_modifications
                # are sorted by 'position' (= insertion index in the original text),
                # and we tracked cumulative_offset against the previous original
                # positions, so by emitting them in order with an index that reflects
                # the already-applied earlier inserts we exactly reproduce the
                # new_text we built locally.
                edit_ops = []
                running_offset = 0
                for mod in text_modifications:
                    edit_ops.append({
                        "type": "insert",
                        "index": mod['position'] + running_offset,
                        "value": mod['new_text'],
                    })
                    running_offset += len(mod['new_text'])
                client.texts.update(text_id, edit_ops)
                
                # Create alignment tokens
                if new_alignment_tokens:
                    response_helper.progress(90, f"Creating {len(new_alignment_tokens)} alignment tokens...")
                    client.tokens.bulk_create(new_alignment_tokens)

                # NOTE: Do NOT update existing alignment-token positions here. The
                # server-side text-edit cascade (apply-text-edit + compensate-after-cascade)
                # already shifts/reindexes those tokens when texts.update runs. Applying
                # our own shifts in the same batch would double-shift them
                # (original + 2 * delta). The text-edit cascade is sufficient.

                # Update sentence partitioning
                if sentence_token_layer_id:
                    response_helper.progress(92, "Updating sentence partitioning...")
                    self._update_sentence_partitioning(
                        client, document, text_id, sentence_token_layer_id,
                        existing_alignment_tokens, new_alignment_tokens, current_text, new_text, text_modifications,
                        overwrite=overwrite
                    )
                
                # Submit all changes atomically
                response_helper.progress(95, "Submitting batch...")
                client.submit_batch()
                
                # Validate temporal ordering invariant - need to get updated tokens from database
                response_helper.progress(98, "Validating temporal ordering...")
                # Re-fetch the document to get updated token positions for validation
                updated_document = client.documents.get(document_id, include_body=True)
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
                                     original_text: str, updated_text: str, text_modifications: List[Dict],
                                     overwrite: bool = False):
        """
        Update sentence partitioning after ASR text insertion.

        The sentence token layer is :partitioning, so the server rejects single
        token create/delete and rejects bulk_create against a non-empty layer or
        bulk_delete that doesn't clear the layer entirely. ASR insertion can also
        invalidate partial-replacement bookkeeping (existing sentence positions
        relative to inserted text), so we take a "full reset" approach:

        1. Gather ALL existing sentence IDs in this layer for this text.
        2. Build a NEW complete partition of [0, len(updated_text)) using the
           combined alignment tokens (existing positions reindexed for the inserted
           text + the new alignment tokens) as anchors.
        3. In the current batch: bulk_delete all existing + bulk_create the new
           partition. Both must run inside the SAME batch so the layer is empty
           in-tx when bulk_create runs (it rejects against a non-empty layer).
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

        # Nothing to anchor sentences against
        if not new_alignment_tokens:
            return

        existing_sentence_tokens = sentence_token_layer.get("tokens", [])
        text_length = len(updated_text)

        # Provenance write contract: the full reset below cascade-deletes every
        # sentence-level annotation. Machine-made UNVERIFIED ones are
        # replaceable; human-made or human-verified ones are not — fail closed
        # (raising aborts the batch BEFORE submit) unless explicitly overwriting.
        if existing_sentence_tokens and not overwrite:
            deleted_ids = {s.get("id") for s in existing_sentence_tokens}
            protected = 0
            for sl in sentence_token_layer.get('span_layers', []) or []:
                for span in sl.get('spans', []) or []:
                    if any(tid in deleted_ids for tid in (span.get('tokens') or [])) \
                            and is_protected(span.get('metadata')):
                        protected += 1
            for vocab in sentence_token_layer.get('vocabs', []) or []:
                for vl in vocab.get('vocab_links', []) or []:
                    if any(tid in deleted_ids for tid in (vl.get('tokens') or [])) \
                            and is_protected(vl.get('metadata')):
                        protected += 1
            if protected:
                raise ValueError(
                    f"Transcribing would reset the sentence partition and delete {protected} "
                    f"human-made or human-verified sentence-level annotation(s); re-run with "
                    f"overwrite enabled to replace them."
                )

        if text_length <= 0:
            # Empty text — partition must be empty too. Clear if anything exists.
            if existing_sentence_tokens:
                client.tokens.bulk_delete([s["id"] for s in existing_sentence_tokens if "id" in s])
            return

        # Reindex existing alignment tokens to their post-insertion positions
        updated_existing_tokens = []
        for token in existing_alignment_tokens:
            token_begin = token.get("begin", 0)
            adjustment = sum(len(mod['new_text']) for mod in text_modifications
                             if mod['position'] <= token_begin)
            updated_token = dict(token)
            updated_token["begin"] = token_begin + adjustment
            updated_token["end"] = token.get("end", 0) + adjustment
            updated_existing_tokens.append(updated_token)

        all_alignment_tokens = updated_existing_tokens + list(new_alignment_tokens)

        # Build a complete partition of [0, text_length) anchored on the alignment tokens
        new_sentences = self._create_sentences_from_alignment_tokens(
            all_alignment_tokens, text_id, sentence_token_layer_id,
            full_text=updated_text, text_start=0, text_end=text_length
        )

        new_sentences = self._normalize_partition(new_sentences, text_id, sentence_token_layer_id, text_length)

        if not new_sentences:
            print("Warning: Could not build a sentence partition; skipping sentence update")
            return

        if not self._is_complete_partition(new_sentences, text_length):
            # Fail closed (consistent with token_processor's pre-check). If
            # _normalize_partition can't produce a valid partition, that is a
            # bug we want to surface, not paper over with a half-cooked
            # bulk_create that the server will reject anyway (rolling back the
            # whole ASR batch — text update included). Raising here aborts
            # this batch BEFORE submit, so no destructive state changes.
            raise ValueError(
                f"Computed sentence partition does not cleanly cover "
                f"[0, {text_length}); aborting sentence partition update"
            )

        # TODO(annotation-preservation): ASR runs incrementally, and this full-reset
        # bulk_delete + bulk_create wipes every sentence-level annotation (spans,
        # vocab-links, relations grounded on sentence spans) on EACH ASR pass. That
        # is the right thing to do only if the new partition were unrelated to the
        # old one.
        #
        # We investigated whether the new partition is always a strict REFINEMENT of
        # the old (i.e. every existing boundary survives, the new partition only adds
        # cut points). It is NOT, in general:
        #   * `_create_sentences_from_alignment_tokens` anchors each sentence's END
        #     on an alignment token's `end` and each sentence's START on the
        #     preceding token's `end`. Inserting a new alignment token BETWEEN two
        #     existing ones therefore moves the boundary that used to sit at
        #     `prev.end` to the new inserted token's `end` — a DIFFERENT offset.
        #     So old boundaries don't survive byte-exactly.
        #   * Even if they did, ASR can insert tokens before the very first existing
        #     token, shifting the leading sentence's start (which the normalizer
        #     then pushes back to 0).
        #
        # A correct incremental approach would be:
        #   1. Walk old sentence boundaries vs. new sentence boundaries.
        #   2. For each old boundary that has a corresponding new boundary at the
        #      same (post-cascade) offset, leave that sentence's identity alone.
        #   3. For each new boundary inside an existing sentence, call
        #      `client.tokens.split(sentence_id, position)` — this preserves the
        #      original sentence's annotations on the LEFT half.
        #   4. For any remaining mismatches, fall back to full reset on only the
        #      affected sub-range.
        # This is complex enough that we're deferring it. If sentence-level
        # annotation loss becomes a real problem for ASR users, implement the
        # refinement-detection path above.
        #
        # Full reset: clear the whole layer first (partitioning rejects partial bulk_delete),
        # then establish the new partition. Must be in the same batch (the layer must be
        # empty in-tx when bulk_create runs).
        existing_ids = [s["id"] for s in existing_sentence_tokens if "id" in s]
        if existing_ids:
            client.tokens.bulk_delete(existing_ids)
        client.tokens.bulk_create(new_sentences)

    def _normalize_partition(self, sentences: List[Dict], text_id: str, sentence_token_layer_id: str,
                              text_length: int) -> List[Dict]:
        """Normalize a list of sentence dicts to a complete partition of [0, text_length).

        Drops zero/negative widths, clamps overlaps by extending the previous end, and
        fills leading/interior/trailing gaps. The result either tiles [0, text_length)
        exactly or is empty (when text_length <= 0).
        """
        if text_length <= 0:
            return []

        cleaned = []
        for s in sorted(sentences, key=lambda x: (x.get('begin', 0), x.get('end', 0))):
            b = max(0, min(s.get('begin', 0), text_length))
            e = max(0, min(s.get('end', 0), text_length))
            if e > b:
                cleaned.append({
                    "token_layer_id": sentence_token_layer_id,
                    "text": text_id,
                    "begin": b,
                    "end": e,
                })

        resolved = []
        cursor = 0
        for s in cleaned:
            b = max(s['begin'], cursor)
            e = max(s['end'], b)
            if e > b:
                resolved.append({
                    "token_layer_id": sentence_token_layer_id,
                    "text": text_id,
                    "begin": b,
                    "end": e,
                })
                cursor = e

        if not resolved:
            return [{
                "token_layer_id": sentence_token_layer_id,
                "text": text_id,
                "begin": 0,
                "end": text_length,
            }]

        # Fill leading gap by EXTENDING the first sentence's begin to 0, mirroring
        # the trailing-gap behavior below. Keeps the partition symmetric and
        # minimizes the sentence count.
        partition = [dict(resolved[0])]
        if partition[0]['begin'] > 0:
            partition[0]['begin'] = 0

        for i in range(1, len(resolved)):
            s = resolved[i]
            partition.append(dict(s))
            if partition[-2]['end'] < s['begin']:
                partition[-2]['end'] = s['begin']

        if partition[-1]['end'] < text_length:
            partition[-1]['end'] = text_length

        return partition

    def _is_complete_partition(self, sentences: List[Dict], text_length: int) -> bool:
        """Check that sentences tile [0, text_length) exactly with no gaps/overlaps/zero-widths."""
        if text_length <= 0:
            return len(sentences) == 0
        if not sentences:
            return False
        sorted_s = sorted(sentences, key=lambda x: x['begin'])
        if sorted_s[0]['begin'] != 0 or sorted_s[-1]['end'] != text_length:
            return False
        for i, s in enumerate(sorted_s):
            if s['end'] <= s['begin']:
                return False
            if i + 1 < len(sorted_s) and s['end'] != sorted_s[i + 1]['begin']:
                return False
        return True
    
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