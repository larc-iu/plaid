"""
ASR Service Framework

This package provides reusable components for building ASR services with Plaid.
It abstracts away common functionality like service registration, authentication,
alignment processing, and text management.
"""

from .asr_model import ASRModel, Alignment
from .alignment_processor import AlignmentProcessor, may_overlap
from .channels import extract_channel, wav_channel_count

# BaseService is imported separately to avoid circular imports

__all__ = ['ASRModel', 'Alignment', 'AlignmentProcessor', 'may_overlap', 'extract_channel',
           'wav_channel_count']