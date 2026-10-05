"""
Alignment Processor

Handles the complex logic of inserting ASR alignments into Plaid documents
while managing text insertion, collision detection, position updates, and
sentence partitioning.
"""

import os
import requests
from typing import List, Dict, Optional

from plaid_client.provenance import stamp_inferred
from plaid_client.http import PlaidAPIError
from plaid_client.ids import uuid7
from plaid_client.service import locked_for_writes, requester_message
from plaid_client.workflows.messages import setup_incomplete
from plaid_client.workflows.partition import partition
from plaid_client.workflows.igt.new_words import is_js_space, layer_new_words, words_refused

from .asr_model import Alignment

# Media download budgets. Both are STALL budgets, not caps on the transfer:
# how long to wait for the connection, and how long one chunk may take.
CONNECT_TIMEOUT_S = 15
READ_TIMEOUT_S = 60
CHUNK_BYTES = 1 << 16


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
                          prov_source: Optional[str] = None, overwrite: bool = False,
                          lock_percent: int = 2, word_token_layer_id: Optional[str] = None) -> int:
        """
        Process ASR alignments and update the Plaid document.

        Alignment tokens are insertion-only and time-collision-aware: existing
        ones are never modified or deleted. Neither are sentences: each new
        segment's sentence is split out of the sentences there
        (``_update_sentence_partitioning``), so the words nested in them and
        every annotation stay.

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
            overwrite: Accepted for callers that pass it. The run deletes no
                annotation, so there is nothing for it to allow.
            lock_percent: The percent to report the lock step at. The rest of
                the run reports 75 to 98, so a caller that has already done
                work of its own passes what it has reached: the default is
                what this reports standing alone, and left at it after a
                transcription the bar ran 70, then 2, then 75.
            word_token_layer_id: Optional ID of the word token layer. When
                given, the text the run adds gets the words its "Tokenize new
                text" gives it (``plaid_client.workflows.igt.new_words``, read
                off that layer's config, none when it is off), in the batch
                that writes the text.

        Returns:
            Number of new alignment tokens created
        """
        # Hold the document lock since we'll be modifying text and tokens; the
        # context manager acquires it (refusing with a clear error if another
        # user holds it) and always releases on exit. See
        # PlaidClient.documents.locked. Its writes carry the version the
        # document has once held, so one that lands late is refused.
        response_helper.progress(lock_percent, "Writing the transcription…")
        with locked_for_writes(client, document_id):
            # Convert alignments to transcription format, in time order: a
            # model's segments are not always sorted by start, and segments
            # that land at one place in the text stand in the order given.
            transcriptions = sorted((
                {
                    'text': alignment.text,
                    'start': alignment.start,
                    'end': alignment.end,
                    'metadata': alignment.metadata
                }
                for alignment in alignments
            ), key=lambda t: t['start'])

            # Create time alignment tokens (preserve existing ones)
            tokens_created = self._create_time_alignment_tokens(
                client, document_id, transcriptions, text_layer_id,
                alignment_token_layer_id, sentence_token_layer_id, response_helper,
                prov_source=prov_source, overwrite=overwrite, word_token_layer_id=word_token_layer_id
            )

            return tokens_created
    
    def download_media_file(self, client, media_url: str, temp_dir: str, on_progress=None) -> str:
        """
        Download media file from authenticated URL.
        
        Args:
            client: PlaidClient instance with authentication
            media_url: URL of media file to download
            temp_dir: Temporary directory for downloaded file
            
        Returns:
            Path to downloaded file
            
        Raises:
            ValueError: If the download fails, with a reason the requester reads
        """
        try:
            # The token goes in the header, not the query string. A media URL
            # already carries a `?v=` cache-buster, so appending `?token=` made
            # a second `?`: the token was swallowed into the `v` parameter and
            # the request arrived unauthenticated (401). A header also keeps the
            # token out of access logs, which is why the browser client stopped
            # putting it in the URL.
            #
            # The timeout is a STALL timeout: a connect budget and a per-chunk
            # read budget, not a cap on the download, so a large file over a
            # slow link still arrives while a server that stops sending does
            # not hold the request open forever with nothing to report.
            response = requests.get(
                media_url,
                stream=True,
                headers={'Authorization': f'Bearer {client.token}'},
                timeout=(CONNECT_TIMEOUT_S, READ_TIMEOUT_S),
            )
            response.raise_for_status()

            total = int(response.headers.get('Content-Length') or 0)
            temp_file = os.path.join(temp_dir, "media")
            read = 0
            with open(temp_file, 'wb') as f:
                for chunk in response.iter_content(chunk_size=CHUNK_BYTES):
                    f.write(chunk)
                    read += len(chunk)
                    if on_progress:
                        on_progress(read, total)

            return temp_file

        except Exception as e:
            # The exception names the media URL, which is the operator's
            # business; the requester is told what failed, not where.
            print(f"Failed to download media file: {e}")
            raise ValueError(f"The document's media file could not be downloaded "
                             f"({requester_message(e)}).")

    def _create_time_alignment_tokens(self, client, document_id: str, transcriptions: List[Dict],
                                     text_layer_id: str, alignment_token_layer_id: str,
                                     sentence_token_layer_id: Optional[str], response_helper,
                                     prov_source: Optional[str] = None, overwrite: bool = False,
                                     word_token_layer_id: Optional[str] = None) -> int:
        """Create time alignment tokens from transcription results, preserving existing work"""
        # Get document with full token information
        response_helper.progress(75, "Reading the document…")
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
            raise setup_incomplete(f"text layer {text_layer_id} not found in document {document_id}")
        
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
        
        response_helper.progress(78, "Skipping segments that overlap existing ones…")
        
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
        
        response_helper.progress(82, f"Adding {len(non_colliding_transcriptions)} segment{'' if len(non_colliding_transcriptions) == 1 else 's'}…")
        
        # Step 2 & 3: For each non-colliding transcription, update text and create tokens
        new_alignment_tokens = []
        
        # We'll need to track text changes to update positions correctly
        text_modifications = []  # List of (position, old_length, new_text) tuples
        
        for trans in non_colliding_transcriptions:
            segment_text = trans['text'].strip()
            if not segment_text:
                continue
            
            # Find insertion point in text based on time
            insertion_pos = self._find_text_insertion_position(current_text, existing_alignment_tokens, trans['start'])
            
            # The spaces that keep it apart from its neighbours are added once
            # the inserts are in text order (`_pad`).
            new_segment_text = segment_text

            # Track this modification
            text_modifications.append({
                'position': insertion_pos,
                'old_length': 0,
                'new_text': new_segment_text,
                'segment_start_offset': 0,  # past the space `_pad` puts before it
                'segment_length': len(segment_text),  # Token length is just the segment text
                'time_start': trans['start'],
                'time_end': trans['end'],
                'metadata': trans.get('metadata', {})
            })
        
        # Apply text modifications and create tokens
        if text_modifications:
            response_helper.progress(85, "Adding the text…")
            
            # Sort modifications by position (forward order for sequential application)
            text_modifications.sort(key=lambda m: m['position'])
            self._pad(current_text, text_modifications)
            
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
            
            self._refuse_out_of_time_order(
                self._shifted(existing_alignment_tokens, text_modifications), new_alignment_tokens)

            words = self._new_words(text_layer, word_token_layer_id, sentence_token_layer_id, text_id,
                                    current_text, text_modifications)
            try:
                self._write(client, document, text_id, text_modifications, new_alignment_tokens,
                            words, existing_alignment_tokens, current_text, new_text,
                            sentence_token_layer_id, response_helper, overwrite)
            except PlaidAPIError as e:
                # A new word over one the server placed, or outside every
                # sentence: the batch stored nothing, and it goes again
                # without the words.
                if not words or not words_refused(e):
                    raise
                self._write(client, document, text_id, text_modifications, new_alignment_tokens,
                            [], existing_alignment_tokens, current_text, new_text,
                            sentence_token_layer_id, response_helper, overwrite)

        return len(new_alignment_tokens)

    @staticmethod
    def _pad(current_text: str, text_modifications: List[Dict]) -> None:
        """Give each insert (in text order) a space before it when the
        character before it is not whitespace (JavaScript's, as the Media
        tab reads it), and one after it when the text
        after it does not start with whitespace, so a segment's text never runs
        into the text beside it: "one" and "two three" make "one two three".
        Inserts at one place stand in the order given, each apart from the one
        before it."""
        for i, mod in enumerate(text_modifications):
            pos = mod['position']
            prev = text_modifications[i - 1] if i > 0 else None
            if prev is not None and prev['position'] == pos:
                before = prev['new_text'][-1:]
            else:
                before = current_text[pos - 1:pos]
            nxt = text_modifications[i + 1] if i + 1 < len(text_modifications) else None
            after = '' if nxt is not None and nxt['position'] == pos else current_text[pos:pos + 1]
            lead = ' ' if before and not is_js_space(before) else ''
            trail = ' ' if after and not is_js_space(after) else ''
            mod['new_text'] = lead + mod['new_text'] + trail
            mod['segment_start_offset'] = len(lead)

    @staticmethod
    def _new_words(text_layer: Dict, word_token_layer_id: Optional[str],
                   sentence_token_layer_id: Optional[str], text_id: str,
                   current_text: str, text_modifications: List[Dict]) -> List[Dict]:
        """The words the inserted text gets from the word layer's "Tokenize
        new text", as bulk-create rows, measured on the text read and kept
        inside its sentences. Inserts at one place are one gap, in the order
        they are written."""
        if not word_token_layer_id:
            return []
        layer = next((tl for tl in text_layer.get("token_layers", [])
                      if tl.get("id") == word_token_layer_id), None)
        if layer is None:
            return []
        sentences = next((tl.get("tokens") or [] for tl in text_layer.get("token_layers", [])
                          if tl.get("id") == sentence_token_layer_id), [])
        gaps: List[Dict] = []
        for mod in text_modifications:
            if gaps and gaps[-1]['start'] == mod['position']:
                gaps[-1]['value'] += mod['new_text']
            else:
                gaps.append({'start': mod['position'], 'end': mod['position'], 'value': mod['new_text']})
        return [{"token_layer_id": word_token_layer_id, "text": text_id, "begin": b, "end": e}
                for b, e in layer_new_words(layer.get("config"), current_text, gaps,
                                            layer.get("tokens") or [], sentences)]

    def _write(self, client, document, text_id, text_modifications, new_alignment_tokens, words,
               existing_alignment_tokens, current_text, new_text, sentence_token_layer_id,
               response_helper, overwrite):
        """The run's one batch: the text, the segments, the sentences and the
        new words."""
        # Begin atomic batch operation
        response_helper.progress(88, "Saving…")
        with client.batched() as b:

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
            b.texts.update(text_id, edit_ops)
        
            # Create alignment tokens
            if new_alignment_tokens:
                response_helper.progress(90, f"Aligning {len(new_alignment_tokens)} segment{'' if len(new_alignment_tokens) == 1 else 's'}…")
                b.tokens.bulk_create(new_alignment_tokens)

            # NOTE: Do NOT update existing alignment-token positions here. The
            # server-side text-edit cascade (apply-text-edit + compensate-after-cascade)
            # already shifts/reindexes those tokens when texts.update runs. Applying
            # our own shifts in the same batch would double-shift them
            # (original + 2 * delta). The text-edit cascade is sufficient.

            # Update sentence partitioning
            if sentence_token_layer_id:
                response_helper.progress(92, "Updating the sentences…")
                self._update_sentence_partitioning(
                    b, document, text_id, sentence_token_layer_id,
                    existing_alignment_tokens, new_alignment_tokens, current_text, new_text, text_modifications,
                    new_words=words,
                )
        
            # The new words, once the sentences they lie in are there.
            if words:
                b.tokens.bulk_create(words)

            # All queued ops are submitted atomically when this
            # `with client.batched()` block exits.
            response_helper.progress(95, "Saving…")

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
    
    @staticmethod
    def _shifted(tokens: List[Dict], text_modifications: List[Dict]) -> List[Dict]:
        """``tokens`` at their places once ``text_modifications`` are inserted
        (an insert at a token's begin goes before it)."""
        out = []
        for token in tokens:
            begin = token.get("begin", 0)
            shift = sum(len(mod['new_text']) for mod in text_modifications if mod['position'] <= begin)
            out.append({**token, "begin": begin + shift, "end": token.get("end", 0) + shift})
        return out

    @staticmethod
    def _refuse_out_of_time_order(existing: List[Dict], new: List[Dict]) -> None:
        """Refuse, before anything is written, a new segment that stands in the
        text before a segment that begins earlier in time, or after one that
        begins later. Segments already out of order among themselves are left
        as a person put them."""
        def time(t):
            return (t.get("metadata") or {}).get("timeBegin", 0)
        tokens = sorted([(time(t), t["begin"], False) for t in existing]
                        + [(time(t), t["begin"], True) for t in new])
        # The furthest text position of a segment strictly earlier in time,
        # and the nearest of one strictly later, for each time.
        times = sorted({t for t, _, _ in tokens})
        latest_before, pos_max = {}, -1
        earliest_after, pos_min = {}, float('inf')
        by_time = {}
        for t, pos, _ in tokens:
            by_time.setdefault(t, []).append(pos)
        for t in times:
            latest_before[t] = pos_max
            pos_max = max(pos_max, max(by_time[t]))
        for t in reversed(times):
            earliest_after[t] = pos_min
            pos_min = min(pos_min, min(by_time[t]))
        for t, pos, is_new in tokens:
            if not is_new:
                continue
            after = latest_before[t] >= pos
            if not after and earliest_after[t] > pos:
                continue
            # The segment in the way: earlier in time and after it in the
            # text, or later in time and before it.
            u, _, other_new = next(x for x in tokens
                                   if ((x[0] < t and x[1] >= pos) if after
                                       else (x[0] > t and x[1] <= pos)))
            whose = 'new segment' if other_new else "document's segment"
            raise ValueError(
                f"The new segment at {t:g} s has no place in time order: the {whose} at {u:g} s "
                f"stands {'after' if after else 'before'} it in the text. Put the document's "
                f"segments in time order first. Nothing was written.")

    def _update_sentence_partitioning(self, batch, document: Dict, text_id: str, sentence_token_layer_id: str,
                                     existing_alignment_tokens: List[Dict], new_alignment_tokens: List[Dict],
                                     original_text: str, updated_text: str, text_modifications: List[Dict],
                                     new_words: List[Dict] = ()):
        """
        Give each new segment a sentence of its own, on the batch it is handed.

        A sentence runs from the end of the segment before it in the text to
        the end of its own segment. A layer with no sentences gets a whole
        partition so (bulk create). Otherwise no sentence is deleted: the
        sentences as the inserts leave them are split at the new segments'
        boundaries (``tokens.split``), so every word nested in them, and every
        annotation on a sentence or a word, stays (REV-R4-TOK F1: a full reset
        deleted every sentence, and the core took the nested words and their
        glosses with them). A boundary that already is one, or that lies
        inside a word, or that would leave a sentence of whitespace alone, is
        left alone.
        """
        sentence_token_layer = None
        text_layer = None
        for tl in document["text_layers"]:
            if tl.get("text", {}).get("id") == text_id:
                text_layer = tl
                for token_layer in tl.get("token_layers", []):
                    if token_layer["id"] == sentence_token_layer_id:
                        sentence_token_layer = token_layer
                        break
                break

        if not sentence_token_layer or not new_alignment_tokens:
            return

        existing_sentence_tokens = sentence_token_layer.get("tokens", [])
        text_length = len(updated_text)
        if text_length <= 0:
            return

        all_alignment_tokens = sorted(self._shifted(existing_alignment_tokens, text_modifications)
                                      + list(new_alignment_tokens), key=lambda t: t["begin"])

        if not existing_sentence_tokens:
            new_sentences = self._create_sentences_from_alignment_tokens(
                all_alignment_tokens, text_id, sentence_token_layer_id,
                full_text=updated_text, text_start=0, text_end=text_length
            )
            batch.tokens.bulk_create([{"token_layer_id": sentence_token_layer_id, "text": text_id, **r}
                                      for r in partition(new_sentences, text_length)])
            return

        # The sentences as the inserts leave them: text inserted at a boundary
        # goes to the sentence before it, as the core puts it.
        def moved(p: int, start: bool) -> int:
            if start and p == 0:
                return 0
            return p + sum(len(m['new_text']) for m in text_modifications if m['position'] <= p)

        sentences = sorted([moved(t["begin"], True), moved(t["end"], False), t["id"]]
                           for t in existing_sentence_tokens)
        # Every other token over the text (the words and morphemes nested in
        # the sentences), where the inserts leave it, and the new words.
        # An insert at a token's edge stands outside it (the inserts are
        # padded with whitespace, `_pad`).
        def shift(p: int, inclusive: bool) -> int:
            return p + sum(len(m['new_text']) for m in text_modifications
                           if (m['position'] <= p if inclusive else m['position'] < p))

        skip = {sentence_token_layer_id} | {a.get("token_layer_id") for a in new_alignment_tokens}
        inner = [(shift(t["begin"], True), shift(t["end"], False))
                 for tl in (text_layer or {}).get("token_layers", []) if tl["id"] not in skip
                 for t in tl.get("tokens", [])]
        inner += [(w["begin"], w["end"]) for w in new_words]

        def blank(a: int, z: int) -> bool:
            return all(is_js_space(c) for c in updated_text[a:z])

        new_ids = {id(t) for t in new_alignment_tokens}
        boundaries = set()
        for k, token in enumerate(all_alignment_tokens):
            if id(token) in new_ids:
                boundaries.add(token["end"])
                if k > 0:
                    boundaries.add(all_alignment_tokens[k - 1]["end"])
        for b in sorted(boundaries):
            if not 0 < b < text_length:
                continue
            hit = next((s for s in sentences if s[0] < b < s[1]), None)
            if hit is None or any(ib < b < ie for ib, ie in inner):
                continue
            # Never a sentence of whitespace alone: the boundary already
            # there past a line break stands for this one.
            if blank(hit[0], b) or blank(b, hit[1]):
                continue
            right = uuid7()
            batch.tokens.split(hit[2], b, id=right)
            sentences.append([b, hit[1], right])
            hit[1] = b
            sentences.sort()

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