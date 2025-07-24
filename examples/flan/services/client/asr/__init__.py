"""
ASR Service Framework

This package provides reusable components for building ASR services with Plaid.
It abstracts away common functionality like service registration, authentication,
alignment processing, and text management.
"""

from .asr_model import ASRModel, Alignment
from .alignment_processor import AlignmentProcessor

# BaseService is imported separately to avoid circular imports

__all__ = ['ASRModel', 'Alignment', 'AlignmentProcessor']