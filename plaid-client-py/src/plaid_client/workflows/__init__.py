"""Reusable workflow frameworks for building Plaid services.

These implement common annotation workflows on top of the app-interop layer
role conventions (``config.plaid.role`` — see the manual's Layer
Interoperability chapter), so a service built on them works against any
project whose layers carry the standard roles:

- ``plaid_client.workflows.tokenization`` — sentence/word tokenization:
  a ``TokenizerModel`` you subclass plus a ``TokenProcessor`` that writes
  token spans (collision-safe, batch-friendly).
- ``plaid_client.workflows.asr`` — speech transcription: an ``ASRModel`` you
  subclass plus an ``AlignmentProcessor`` that writes time-aligned tokens.

Official service files (``igt_tokenize_punkt.py``, ``igt_transcribe_whisper.py``,
...) are single standalone scripts that import these frameworks — use them as
templates for your own services.
"""

from . import asr, tokenization

__all__ = ['asr', 'tokenization']
