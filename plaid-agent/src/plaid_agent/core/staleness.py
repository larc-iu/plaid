"""Whether a plan still fits the documents it was made against: the check an
approval makes before it writes anything."""

import traceback
from typing import Dict, List, Optional

from plaid_client.service import requester_message

from .plan import HELD_FROM


def _named(name) -> str:
    """A document as the user knows it: by name, never by id."""
    return f'document "{name}"' if name else 'a document'


def _numbers(indexes: List[int]) -> str:
    """Sentence numbers as a reader says them: "3", "3 and 5", "3, 5 and 8"."""
    shown = [str(i) for i in sorted(indexes)]
    return shown[0] if len(shown) == 1 else ', '.join(shown[:-1]) + ' and ' + shown[-1]


def changed_sentences(recorded: list, now: Dict[str, tuple]) -> Optional[List[int]]:
    """The numbers of the recorded sentences whose fingerprint differs now, or
    None when one of them is gone (the plan names a sentence that no longer
    exists, so it cannot apply at all)."""
    out: List[int] = []
    for entry in recorded:
        if not isinstance(entry, dict) or not entry.get('id') or not entry.get('print'):
            return None
        found = now.get(entry['id'])
        if found is None:
            return None
        if found[1] != entry['print']:
            out.append(found[0])
    return out


def stale_documents(client, documents: list, reread=None) -> list:
    """Which of the plan's documents changed since it was made: every write
    inside a document bumps its version, so a version mismatch means the
    plan's ids and offsets may have been read from data that is no longer
    there.

    A document whose record lists ``sentences`` (the fingerprint of each one
    the plan's changes depend on) is checked more finely when its version has
    moved: ``reread(document_id)`` gives the fingerprints as they are now, and
    only those sentences are compared, so an edit elsewhere in the document
    does not refuse the plan (ruled 2026-09-28). Without a list, or
    without ``reread``, the version alone decides, as it always did.

    A document an earlier run of the plan held (``held_from``) is not
    compared: that run may have written to it, which moves its version and
    changes its sentences, and the check would refuse the run again saying
    nothing was written. The run again holds it at the version the first run
    held it at, so what landed is answered from its first send, and what did
    not claims the version the answers leave, which the server refuses if
    anyone else has written since."""
    out = []
    for d in documents:
        # A record with no id or no version cannot be checked, and skipping it
        # applied the plan anyway: the one case this exists to catch is the
        # one where the check could not run.
        if not isinstance(d, dict) or not d.get('id'):
            out.append('the plan names a document it cannot identify, so nothing can be checked '
                       'against it')
            continue
        if d.get('version') is None:
            out.append(f'{_named(d.get("name"))} was recorded without a version, so '
                       f'whether it has changed since the plan was made cannot be told')
            continue
        try:
            now = client.documents.get(d['id'])
        except Exception as e:  # noqa: BLE001 - deleted or unreadable: the plan cannot apply
            out.append(f'{_named(d.get("name"))} could not be read ({requester_message(e)})')
            continue
        # Reached by rules alone: what they match there is checked by its
        # digest when they are found again (`core.rules.check_matched`), so an
        # edit elsewhere in the document does not refuse the plan.
        if now.get('version') == d['version'] or d.get(HELD_FROM) is not None or d.get('rule'):
            continue
        named = _named(now.get('name') or d.get('name'))
        changed = None
        if d.get('sentences') and reread is not None:
            try:
                changed = changed_sentences(d['sentences'], reread(d['id']))
            except Exception:  # noqa: BLE001 - unreadable now: fall back to the version, which moved
                traceback.print_exc()
                changed = None
        if changed is None:
            out.append(f'{named} has changed since the plan was made')
        elif changed:
            many = len(changed) > 1
            out.append(f'sentence{"s" if many else ""} {_numbers(changed)} of {named} '
                       f'{"have" if many else "has"} changed since the plan was made')
    return out
