"""
Token Processor

Handles the complex logic of managing tokens in Plaid documents including
collision detection, boundary management, cross-sentence splitting, and
batch operations.
"""

import logging
from typing import List, Dict, Any, Optional
from .tokenizer_model import TokenSpan

logger = logging.getLogger(__name__)


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

            # Decide whether we're resetting the sentence partition, and compute the
            # NEW sentence boundaries BEFORE splitting words. We need the new
            # boundaries up-front because words straddling a new sentence boundary
            # will be rejected by enforce-nesting (word layer is nested under
            # sentence). If we only split against the OLD partition (which is the
            # single full-text sentence whenever should_do_sentences is True),
            # any word straddling a new sentence boundary makes the whole batch
            # roll back.
            should_do_sentences = sentence_layer and self._should_tokenize_sentences(existing_sentences)
            sentences_to_create = []
            sentence_ids_to_delete = []
            text_length = len(text_content)

            if should_do_sentences:
                response_helper.progress(33, "Processing sentence tokenization...")
                # Sentence layer is :partitioning — must replace via bulk_delete + bulk_create
                # in one batch. Build a complete partition covering [0, text_length) exactly,
                # filling any gaps left by the tokenizer so the server accepts it.
                sentence_ids_to_delete = [s['id'] for s in existing_sentences]
                sentences_to_create = self._normalize_sentence_partition(
                    [{'begin': s['begin'], 'end': s['end']} for s in new_sentences_dict],
                    text_length
                )
                # Pre-check: complete cover of [0, text_length), no gaps/overlaps/zero-widths
                if not self._is_complete_partition(sentences_to_create, text_length):
                    response_helper.error(
                        f"Sentence tokenization did not produce a valid partition of [0, {text_length})"
                    )
                    return {"tokensCreated": 0, "tokensDeleted": 0, "sentencesCreated": 0}
            elif sentence_layer and len(existing_sentences) != 1:
                response_helper.progress(33, "Skipping sentence tokenization (not exactly one existing sentence)...")

            # Boundaries to split against for word-level processing. When the
            # sentence partition is being reset, words must respect the NEW
            # boundaries (otherwise enforce-nesting rejects). Otherwise (no
            # sentence change), they must respect the OLD boundaries.
            if should_do_sentences:
                split_boundaries = [
                    {'begin': s['begin'], 'end': s['end']} for s in sentences_to_create
                ]
            else:
                split_boundaries = existing_sentence_boundaries

            # Split both existing and new tokens that cross sentence boundaries
            response_helper.progress(35, "Splitting cross-sentence tokens...")

            # Find which existing tokens need to be deleted (those that will be split)
            tokens_to_delete = []
            split_existing_tokens = []

            if split_boundaries:
                existing_tokens_split = self._split_cross_sentence_tokens(
                    [{'begin': t['begin'], 'end': t['end'], 'id': t.get('id')} for t in existing_tokens],
                    split_boundaries
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
                split_boundaries
            )

            response_helper.progress(40, "Merging tokens...")
            words_to_create = self._merge_with_existing_tokens(new_words_split, split_existing_tokens)
            
            # Filter out tokens that already exist — but only when we're NOT resetting
            # the sentence partition. If should_do_sentences is True, the sentence
            # bulk_delete (queued below) cascades to delete every existing word, so we
            # need to recreate all of them — including ones whose ranges happen to
            # match existing words verbatim.
            if not should_do_sentences:
                existing_ranges = {(t['begin'], t['end']) for t in split_existing_tokens}
                words_to_create = [w for w in words_to_create if (w['begin'], w['end']) not in existing_ranges]
            
            # Apply changes
            response_helper.progress(50, "Applying changes...")

            sentences_created = 0
            tokens_deleted = len(tokens_to_delete)

            if words_to_create or sentences_to_create or sentence_ids_to_delete or tokens_to_delete:
                client.begin_batch()

                # TODO(annotation-preservation): when the new sentence partition is a strict
                # REFINEMENT of the existing one (every new boundary falls inside the SAME old
                # sentence — i.e. we're only ADDING cut points, never moving or removing them),
                # we could iteratively `client.tokens.split(sentence_id, position)` to add the
                # cut points instead of doing a full bulk_delete + bulk_create reset. `split`
                # preserves the original sentence's spans and vocab-links on the left half and
                # leaves the right half un-annotated, which is much better than the current
                # behavior of cascade-deleting EVERY sentence-level annotation.
                #
                # We don't bother today because the gate above is "exactly one existing
                # sentence", so the annotation-loss scope is bounded (and we already log a
                # warning below). If we ever loosen the gate to allow re-tokenization across
                # multiple existing sentences, switch to the refinement-check + split path.
                #
                # Reset sentence partition: bulk_delete existing + bulk_create new in one batch.
                # Sentence layer is :partitioning so single delete/create is rejected, and
                # partial bulk_delete is also rejected — we must clear the whole partition.
                if sentence_ids_to_delete:
                    # Warn the operator that any sentence-level annotations on the
                    # existing sentence will be cascade-deleted by the bulk_delete
                    # below. The gate is "exactly one existing sentence" so the
                    # scope is bounded, but the loss is silent without this warning.
                    self._warn_about_sentence_annotation_loss(
                        sentence_layer, sentence_ids_to_delete
                    )
                    client.tokens.bulk_delete(sentence_ids_to_delete)

                # Delete tokens that were split (word-layer tokens, :non-overlapping — single
                # delete is fine here; cascades to dependent morpheme tokens server-side).
                #
                # IMPORTANT: when sentences are being reset, the bulk_delete above already
                # cascade-deletes every word token nested in the deleted sentence partition
                # (the single existing sentence covers [0, text_length), which contains
                # every word). Issuing individual deletes for those same token IDs would
                # 404 (>= 300 -> batch rollback). Only run the per-word delete loop in
                # the word-only retokenization path.
                if not should_do_sentences:
                    for token_id in tokens_to_delete:
                        client.tokens.delete(token_id)

                # Create new sentence tokens (establishes the new partition)
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

    def _warn_about_sentence_annotation_loss(self, sentence_layer: Optional[Dict],
                                              sentence_ids_to_delete: List[str]) -> None:
        """Log a warning if the sentences we're about to bulk_delete have any
        spans or vocab-links attached.

        bulk_delete on a partitioning layer cascade-deletes all spans (and
        relations) and vocab-links rooted on the deleted tokens. The gate
        upstream ensures this is bounded to a single existing sentence, but
        the user has no signal that annotations are being lost. Just log;
        don't change behavior.
        """
        if not sentence_layer or not sentence_ids_to_delete:
            return

        deleted_ids = set(sentence_ids_to_delete)
        annotation_count = 0

        # Spans attached to the existing sentence(s) via any sentence-scope span layer
        for sl in sentence_layer.get('span_layers', []) or []:
            for span in sl.get('spans', []) or []:
                span_tokens = span.get('tokens') or []
                if any(tid in deleted_ids for tid in span_tokens):
                    annotation_count += 1

        # Vocab links attached to the existing sentence(s)
        for vocab in sentence_layer.get('vocabs', []) or []:
            for vl in vocab.get('vocab_links', []) or []:
                link_tokens = vl.get('tokens') or []
                if any(tid in deleted_ids for tid in link_tokens):
                    annotation_count += 1

        if annotation_count > 0:
            logger.warning(
                "Re-tokenizing will delete %d sentence-level annotation(s) "
                "(spans/vocab-links) attached to the existing sentence(s). "
                "This is a cascade effect of resetting the :partitioning "
                "sentence layer via bulk_delete + bulk_create.",
                annotation_count,
            )
    
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
    
    def _normalize_sentence_partition(self, sentences: List[Dict], text_length: int) -> List[Dict]:
        """Normalize a list of sentence ranges into a complete partition of [0, text_length).

        Drops zero-width entries, merges overlaps by clamping, and fills gaps (including
        leading/trailing) so the result tiles [0, text_length) exactly. Required because
        the sentence layer is :partitioning and the server rejects partitions with gaps,
        overlaps, or zero-width tokens.
        """
        if text_length <= 0:
            return []

        # Sort and drop zero/negative-width entries; clamp to [0, text_length)
        cleaned = []
        for s in sorted(sentences, key=lambda x: (x['begin'], x['end'])):
            b = max(0, min(s['begin'], text_length))
            e = max(0, min(s['end'], text_length))
            if e > b:
                cleaned.append({'begin': b, 'end': e})

        # Resolve overlaps by clamping each subsequent range to start at the previous end
        resolved = []
        cursor = 0
        for s in cleaned:
            b = max(s['begin'], cursor)
            e = max(s['end'], b)
            if e > b:
                resolved.append({'begin': b, 'end': e})
                cursor = e

        if not resolved:
            return [{'begin': 0, 'end': text_length}]

        # Fill leading gap by EXTENDING the first sentence's begin to 0 (mirror of
        # the trailing-gap behavior below). Earlier this branch instead inserted a
        # NEW sentence covering [0, first.begin); the asymmetry made the partition
        # less predictable and grew the sentence count for no benefit. Extending
        # the first sentence backward keeps the sentence count minimal.
        partition = [dict(resolved[0])]
        if partition[0]['begin'] > 0:
            partition[0]['begin'] = 0

        # Fill interior gaps by extending preceding sentence's end to next sentence's begin
        for i in range(1, len(resolved)):
            s = resolved[i]
            partition.append(dict(s))
            if partition[-2]['end'] < s['begin']:
                # Extend the preceding sentence forward to close the gap.
                partition[-2]['end'] = s['begin']

        # Fill trailing gap by extending the last sentence
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