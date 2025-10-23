"""
ASR Model Interface

Defines the abstract interface that all ASR models must implement,
along with the Alignment dataclass for representing transcription results.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


@dataclass
class Alignment:
    """
    Represents a single alignment result from ASR transcription.
    
    Attributes:
        text: The transcribed text for this segment
        start: Start time in seconds
        end: End time in seconds  
        metadata: Optional arbitrary metadata from the ASR model
    """
    text: str
    start: float
    end: float
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate alignment data"""
        if self.start < 0:
            raise ValueError("Alignment start time cannot be negative")
        if self.end <= self.start:
            raise ValueError("Alignment end time must be greater than start time")
        if not self.text.strip():
            raise ValueError("Alignment text cannot be empty")


class ASRModel(ABC):
    """
    Abstract base class for ASR models.
    
    Concrete implementations should inherit from this class and implement
    the transcribe_with_alignments method to provide speech recognition
    functionality.
    """
    
    @abstractmethod
    def transcribe_with_alignments(self, audio_path: str) -> List[Alignment]:
        """
        Transcribe an audio file and return time-aligned segments.
        
        Args:
            audio_path: Path to the audio file to transcribe
            
        Returns:
            List of Alignment objects representing transcribed segments
            with timestamps. Alignments should be sorted by start time.
            
        Raises:
            FileNotFoundError: If audio file doesn't exist
            RuntimeError: If transcription fails
            ValueError: If audio format is not supported
        """
        pass
    
    @abstractmethod
    def get_model_info(self) -> Dict[str, Any]:
        """
        Return information about the model. Should have "name" specifying the model variant.
        
        Returns:
            Dictionary containing model metadata like name, version, 
            capabilities, etc.
        """
        pass