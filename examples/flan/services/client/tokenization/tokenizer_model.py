"""
Tokenizer Model Interface

Defines the abstract interface that all tokenizers must implement,
along with the TokenSpan dataclass for representing positioned tokens.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Tuple


@dataclass
class TokenSpan:
    """
    Represents a positioned token from tokenization.
    
    Attributes:
        text: The token text
        start: Start character position in source text
        end: End character position in source text
        metadata: Optional arbitrary metadata from the tokenizer
    """
    text: str
    start: int
    end: int
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate token span data"""
        if self.start < 0:
            raise ValueError("Token start position cannot be negative")
        if self.end <= self.start:
            raise ValueError("Token end position must be greater than start position")
        if not self.text.strip():
            raise ValueError("Token text cannot be empty")


class TokenizerModel(ABC):
    """
    Abstract base class for tokenizer models.
    
    Concrete implementations should inherit from this class and implement
    the tokenize_text method to provide tokenization functionality.
    """
    
    @abstractmethod
    def tokenize_text(self, text: str) -> Tuple[List[TokenSpan], List[TokenSpan]]:
        """
        Tokenize text into sentences and words with positions.
        
        Args:
            text: The input text to tokenize
            
        Returns:
            Tuple of (sentences, words) where each is a list of TokenSpan objects
            with accurate character positions. Sentences and words should be 
            sorted by start position.
            
        Raises:
            RuntimeError: If tokenization fails
            ValueError: If input text is invalid
        """
        pass
    
    @abstractmethod
    def get_model_info(self) -> Dict[str, Any]:
        """
        Return information about the tokenizer.
        
        Returns:
            Dictionary containing tokenizer metadata like name, version, 
            language, etc. Should include a "name" field.
        """
        pass


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


def spans_from_nltk_spans(text: str, spans: List[Tuple[int, int]]) -> List[TokenSpan]:
    """
    Convert NLTK span tuples to TokenSpan objects.
    
    Args:
        text: Original text that was tokenized
        spans: List of (start, end) tuples from NLTK span_tokenize
        
    Returns:
        List of TokenSpan objects
    """
    return [
        TokenSpan(
            text=text[start:end],
            start=start,
            end=end
        )
        for start, end in spans
        if start < end and text[start:end].strip()
    ]