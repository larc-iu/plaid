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
- ``plaid_client.workflows.igt`` — interlinear analysis: derive a document's
  words + morphemes and classify them under the provenance write contract,
  parse and align a proposer's interleaved ``GLOSS(seg)`` output, and write
  the analyses (morpheme chains + gloss spans) in budgeted batches.
- ``plaid_client.workflows.umr`` — Uniform Meaning Representation: resolve the
  UMR layers, read a document as sentence graphs, read and write PENMAN, and
  write drafted graphs in three batched passes.

- ``plaid_client.workflows.requester``: who asked for a run, named in its
  History label and in what it stores (``requester_of``). Every service in
  every app names its requester through it.

Official service files (``igt_tokenize_punkt.py``, ``igt_transcribe_whisper.py``,
...) are single standalone scripts that import these frameworks — use them as
templates for your own services.
"""

from . import asr, igt, requester, tokenization, umr
from .requester import REQUESTED_BY, Requester, requester_of

__all__ = ['asr', 'igt', 'requester', 'tokenization', 'umr',
           'REQUESTED_BY', 'Requester', 'requester_of']
