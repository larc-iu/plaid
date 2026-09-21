"""Attachments with no store behind them, for a workspace in a test.

The real ones are read back out of the user's key/value store a part at a time
(``core/files.py``). Everything above that reads them through the same two
methods, so a test that wants a workspace with a file on it can hand over the
text directly and exercise the rest exactly as a turn does.
"""

from plaid_agent.core.files import Attachment, Attachments

WORDLIST = ('word,translation,source\n'
            'aq\'a,water,EK\n'
            'ch\'al,stone,EK\n'
            'nis,milk,RM\n')

NOTES = 'Session 3, 12 March.\nThe consultant preferred the second form.\nAsk again about the plural.\n'


def attached(*files) -> Attachments:
    """An ``Attachments`` over literal ``(name, text)`` pairs, in the order
    given, as though the user had attached each of them in turn."""
    items = []
    for i, (name, text) in enumerate(files, 1):
        meta = {'id': f'f{i}', 'name': name, 'bytes': len(text.encode('utf-8')),
                'lines': text.count('\n') + (0 if text.endswith('\n') else 1), 'chunks': 1}
        items.append(Attachment(meta, lambda file_id, n, t=text: t))
    return Attachments(items)
