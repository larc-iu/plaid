"""The lemma a new UD word starts with: a copy of its form, made by a rule
and by no person, so a parse may replace it (provenance write contract
rule 1). plaid-ud's ``newUdWord.js`` ``LEMMA_FROM_FORM`` is the app's copy.

Its provDetail names the rule and the version of the code that wrote it, as
every machine write does (R4-2-1): ``<package version>+<8 hex>``, the hex the
start of a SHA-256 over this file, so a change to the rule shows in the data.
The app's version hashes the app's file, so the two copies say which of them
wrote a lemma.
"""

import hashlib
import importlib.metadata
import pathlib

from plaid_client.provenance import stamp_inferred

MODEL = 'builtin:lemma-from-form'


def _version() -> str:
    try:
        package = importlib.metadata.version('larc-plaid-agent')
    except importlib.metadata.PackageNotFoundError:
        package = '0.0.0'
    digest = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()[:8]
    return f'{package}+{digest}'


#: The stamp every lemma the rule makes carries.
LEMMA_FROM_FORM = stamp_inferred('rule:lemma-from-form', detail={'model': MODEL, 'version': _version()})
