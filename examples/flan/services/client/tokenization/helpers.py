"""
Helper Functions for Common Tokenizer Formats

Provides utilities to convert various tokenizer outputs to the TokenSpan format
used by the tokenization framework.
"""

from typing import List, Tuple, Any
from .tokenizer_model import TokenSpan


def spans_from_spacy_doc(doc) -> Tuple[List[TokenSpan], List[TokenSpan]]:
    """
    Convert spaCy Doc object to TokenSpan format.
    
    Args:
        doc: spaCy Doc object
        
    Returns:
        Tuple of (sentences, words) as TokenSpan lists
    """
    sentences = []
    words = []
    
    # Extract sentences
    for sent in doc.sents:
        sentences.append(TokenSpan(
            text=sent.text,
            start=sent.start_char,
            end=sent.end_char
        ))
    
    # Extract words (excluding spaces and punctuation if desired)
    for token in doc:
        if not token.is_space:  # Skip whitespace tokens
            words.append(TokenSpan(
                text=token.text,
                start=token.idx,
                end=token.idx + len(token.text),
                metadata={
                    "pos": token.pos_,
                    "lemma": token.lemma_,
                    "is_alpha": token.is_alpha,
                    "is_punct": token.is_punct
                }
            ))
    
    return sentences, words


def spans_from_nltk_punkt(text: str, punkt_tokenizer) -> Tuple[List[TokenSpan], List[TokenSpan]]:
    """
    Convert NLTK Punkt tokenizer output to TokenSpan format with proper partitioning.
    
    Args:
        text: Original text
        punkt_tokenizer: NLTK PunktSentenceTokenizer instance
        
    Returns:
        Tuple of (sentences, words) as TokenSpan lists
    """
    import nltk.tokenize
    
    # Get raw sentence boundaries from NLTK
    raw_sentences = list(punkt_tokenizer.span_tokenize(text))
    
    # Handle edge case: if no sentences detected, create one covering entire text
    if not raw_sentences:
        sentences = [TokenSpan(text=text, start=0, end=len(text))]
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
            
            sentences.append(TokenSpan(
                text=text[sent_start:sent_end],
                start=sent_start,
                end=sent_end
            ))
    
    # Tokenize words within each sentence
    word_tokenizer = nltk.tokenize.TreebankWordTokenizer()
    words = []
    
    for sentence in sentences:
        sent_text = sentence.text
        # Get word spans relative to sentence
        word_spans = list(word_tokenizer.span_tokenize(sent_text))
        
        # Convert to absolute positions
        for word_start, word_end in word_spans:
            words.append(TokenSpan(
                text=sent_text[word_start:word_end],
                start=sentence.start + word_start,
                end=sentence.start + word_end
            ))
    
    return sentences, words


def spans_from_transformers_tokenizer(text: str, tokenizer, return_offsets_mapping=True) -> List[TokenSpan]:
    """
    Convert Hugging Face transformers tokenizer output to TokenSpan format.
    
    Args:
        text: Original text
        tokenizer: HuggingFace tokenizer instance
        return_offsets_mapping: Whether to use offset mapping for positions
        
    Returns:
        List of word TokenSpan objects
        
    Note:
        Most transformer tokenizers work on subword tokens, so this returns
        individual tokens rather than complete words.
    """
    if return_offsets_mapping:
        # Use offset mapping for accurate positions
        encoding = tokenizer(text, return_offsets_mapping=True)
        tokens = []
        
        for i, (start, end) in enumerate(encoding.offset_mapping):
            if start == end:  # Skip special tokens
                continue
                
            token_text = text[start:end]
            if token_text.strip():  # Skip whitespace-only tokens
                tokens.append(TokenSpan(
                    text=token_text,
                    start=start,
                    end=end,
                    metadata={
                        "token_id": encoding.input_ids[i],
                        "attention_mask": encoding.attention_mask[i] if hasattr(encoding, 'attention_mask') else 1
                    }
                ))
        
        return tokens
    else:
        # Fallback: decode tokens and try to match positions
        tokens = tokenizer.tokenize(text)
        return spans_from_tokens(text, tokens)


def spans_from_whitespace(text: str) -> Tuple[List[TokenSpan], List[TokenSpan]]:
    """
    Simple whitespace-based tokenization.
    
    Args:
        text: Text to tokenize
        
    Returns:
        Tuple of (sentences, words) where sentences are split on double newlines
        and words are split on whitespace
    """
    # Split sentences on double newlines or single newlines
    import re
    
    # Find sentence boundaries (double newline or single newline)
    sentence_pattern = r'\n\s*\n|\n'
    sentence_boundaries = list(re.finditer(sentence_pattern, text))
    
    sentences = []
    last_end = 0
    
    for match in sentence_boundaries:
        if match.start() > last_end:
            sentence_text = text[last_end:match.start()]
            if sentence_text.strip():
                sentences.append(TokenSpan(
                    text=sentence_text,
                    start=last_end,
                    end=match.start()
                ))
        last_end = match.end()
    
    # Handle final sentence
    if last_end < len(text):
        sentence_text = text[last_end:]
        if sentence_text.strip():
            sentences.append(TokenSpan(
                text=sentence_text,
                start=last_end,
                end=len(text)
            ))
    
    # If no sentences found, treat entire text as one sentence
    if not sentences:
        sentences = [TokenSpan(text=text, start=0, end=len(text))]
    
    # Tokenize words by whitespace
    words = []
    for word_match in re.finditer(r'\S+', text):
        words.append(TokenSpan(
            text=word_match.group(),
            start=word_match.start(),
            end=word_match.end()
        ))
    
    return sentences, words


def spans_from_tokens(text: str, tokens: List[str]) -> List[TokenSpan]:
    """
    Convert a list of token strings back to positioned TokenSpans.
    
    This is useful for tokenizers that only return strings without positions.
    Uses simple string matching to find positions.
    
    Args:
        text: Original text that was tokenized
        tokens: List of token strings in order
        
    Returns:
        List of TokenSpan objects with calculated positions
        
    Note:
        This is a fallback method and may not be accurate for all tokenizers.
        Prefer tokenizers that provide span information directly.
    """
    spans = []
    current_pos = 0
    
    for token in tokens:
        if not token.strip():
            continue
            
        # Find the token in the remaining text
        token_start = text.find(token, current_pos)
        if token_start == -1:
            # Token not found, skip it
            continue
            
        token_end = token_start + len(token)
        spans.append(TokenSpan(
            text=token,
            start=token_start,
            end=token_end
        ))
        current_pos = token_end
    
    return spans