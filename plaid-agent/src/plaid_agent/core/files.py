"""What the user attached to a conversation, and how a turn reads it back.

A file dragged into the chat is stored BESIDE the conversation, in the same
private key/value store the record itself lives in (see :mod:`.conversation`),
as many parts as its text takes and nothing else:

``<app>:assistant:<project>:file:<conversation>:<file>:part:<n>``
    One part of the text, stored as a bare JSON string. The store caps one
    value at a megabyte, so a file is cut until every part fits. Where the cuts
    fall is the browser's business and nothing here cares: the parts are joined
    before anything reads them.

There is no entry describing the file, because the record already describes it.
A user item carries ``files`` as ``[{id, name, bytes, lines, chunks}]``, which
is what the person sees on their own message and what a turn resolves against
the store. The conversation is IN the key, so deleting a conversation's files
is a listing of keys and no reads at all.

Why the text stays out of the record: everything in the record is sent to the
model on every later turn. A table of ten thousand rows put there would be paid
for once a turn for the rest of the conversation, and it would crowd out the
replies around it, since `prune` drops tool results to keep the record inside
the store's cap. So a turn is TOLD what arrived (:mod:`.filetools` writes the
note) and reads what it needs through a tool or through run_code. That is the
same bargain everything else in the project is on: a file of any size costs a
few hundred characters of the window until something asks for it.
"""

import csv
import io
import json
from typing import Any, Callable, Dict, List, Optional, Tuple

# Suffixes read as a table of rows. Everything else attached is read as text,
# except JSON, which is a table when it parses as a list of objects.
TABLE_SUFFIXES = ('.csv', '.tsv', '.tab')

# What a sniffed delimiter may be. Restricted on purpose: given free rein the
# sniffer picks a letter that happens to recur, and a one-column file comes
# back cut into pieces.
DELIMITERS = ',\t;|'

# Rows shown wherever a file is previewed rather than read.
PREVIEW_ROWS = 5


class FileGone(Exception):
    """An attachment named by the record is not in the store any more.

    Not a fault to hide: the reference is on the user's own message, so the
    model has been told the file exists and has to be able to say that it
    cannot be read rather than answer as if it had read it.
    """


def file_key(app: str, project_id: str, conv_id: str, file_id: str) -> str:
    return f'{app}:assistant:{project_id}:file:{conv_id}:{file_id}'


def _name_columns(raw: List[str]) -> List[str]:
    """Column names a person can use, from the ones the file gives.

    A blank name is named for its position and a repeated one is numbered,
    because both are addressed by name from code that the model writes: two
    columns called the same thing would silently become one, and the row would
    be missing a value that is plainly there in the file.
    """
    out: List[str] = []
    for i, name in enumerate(raw):
        clean = (name or '').strip() or f'column {i + 1}'
        if clean in out:
            n = 2
            while f'{clean} ({n})' in out:
                n += 1
            clean = f'{clean} ({n})'
        out.append(clean)
    return out


def _delimiter(name: str, text: str) -> str:
    """The delimiter of a separated-values file: what the suffix promises,
    checked against the text, and sniffed when the suffix says nothing."""
    lower = name.lower()
    if lower.endswith(('.tsv', '.tab')):
        return '\t'
    sample = text[:8192]
    try:
        return csv.Sniffer().sniff(sample, delimiters=DELIMITERS).delimiter
    except csv.Error:
        # A single column, or a file too odd to sniff. A comma still reads it
        # as one column, which is what it is.
        return ','


def read_table(name: str, text: str) -> Optional[Tuple[List[str], List[Dict[str, Any]]]]:
    """``(columns, rows)`` when the file reads as a table, else None.

    Rows are dicts keyed by column name, with a missing cell as ``''`` and any
    cell past the last column collected under :func:`overflow_key`. Nothing is
    dropped and nothing raises: a ragged file is a normal file, and the point of
    reading it here rather than in the sandbox is that quoting, newlines inside
    a cell and ragged rows are dealt with once, by the standard library, where
    the text still exists in full.
    """
    lower = name.lower()
    if lower.endswith('.json'):
        return _read_json_table(text)
    if not lower.endswith(TABLE_SUFFIXES):
        return None
    reader = csv.reader(io.StringIO(text, newline=''), delimiter=_delimiter(name, text))
    try:
        header = next(reader)
    except StopIteration:
        return ([], [])
    columns = _name_columns(header)
    overflow = overflow_key(columns)
    rows: List[Dict[str, Any]] = []
    for cells in reader:
        if not cells or (len(cells) == 1 and not cells[0].strip()):
            continue  # a blank line between records, which every hand-made file has
        row = {c: (cells[i] if i < len(cells) else '') for i, c in enumerate(columns)}
        if len(cells) > len(columns):
            row[overflow] = cells[len(columns):]
        rows.append(row)
    return (columns, rows)


def overflow_key(columns: List[str]) -> str:
    """Where a row's cells past the last column go: ``extra``, unless the file
    has a column of that name, and then the first numbered name it does not.

    A fixed key would overwrite a real cell in a file with an "extra" column,
    which is a common enough heading for a notes column that it happened in the
    first file this was tried on.
    """
    name, n = 'extra', 2
    while name in columns:
        name, n = f'extra ({n})', n + 1
    return name


def _read_json_table(text: str) -> Optional[Tuple[List[str], List[Dict[str, Any]]]]:
    """A JSON array of objects, as a table. Any other JSON is text: an array of
    numbers or a nested object has no columns, and pretending otherwise would
    flatten something the code can read properly with json.loads."""
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if not isinstance(value, list) or not value or not all(isinstance(v, dict) for v in value):
        return None
    columns: List[str] = []
    for row in value:
        for k in row:
            if k not in columns:
                columns.append(k)
    return (columns, [{c: row.get(c, '') for c in columns} for row in value])


class Attachment:
    """One attached file: what the record says about it, and its text on
    demand.

    Read once per turn and held: a walk in run_code that asks for the rows in a
    loop pays for the read and the parse on its first pass only.
    """

    def __init__(self, meta: Dict[str, Any], read_part: Callable[[str, int], Optional[str]]):
        self.id = str(meta.get('id') or '')
        self.name = str(meta.get('name') or '') or self.id
        self.bytes = int(meta.get('bytes') or 0)
        self.lines = int(meta.get('lines') or 0)
        self.chunks = max(1, int(meta.get('chunks') or 1))
        self._read_part = read_part
        self._text: Optional[str] = None
        self._table: Optional[Tuple[List[str], List[Dict[str, Any]]]] = None
        self._parsed = False

    def text(self) -> str:
        """The whole file. Raises :class:`FileGone` when a part is missing."""
        if self._text is None:
            parts = []
            for i in range(self.chunks):
                try:
                    part = self._read_part(self.id, i)
                except Exception as e:  # noqa: BLE001 - a store that would not answer reads the same way
                    raise FileGone(f'"{self.name}" could not be read back: '
                                   + ' '.join(str(e).split())[:200])
                if part is None:
                    raise FileGone(f'"{self.name}" is no longer stored with this conversation, so it '
                                   f'cannot be read. Tell the user, and ask them to attach it again.')
                parts.append(part)
            # The byte-order mark leads a file saved by a spreadsheet, and it
            # would otherwise become part of the first column's name.
            self._text = ''.join(parts).lstrip('﻿')
        return self._text

    def table(self) -> Optional[Tuple[List[str], List[Dict[str, Any]]]]:
        """``(columns, rows)``, or None when this file is not a table.

        The suffix is consulted BEFORE the text is fetched, so asking what
        shape a four-megabyte plain-text file is in does not read it.
        """
        if not self._parsed:
            self._parsed = True
            lower = self.name.lower()
            if lower.endswith(TABLE_SUFFIXES) or lower.endswith('.json'):
                self._table = read_table(self.name, self.text())
        return self._table

    def preview(self, rows: int = PREVIEW_ROWS) -> str:
        """The first lines, as they are written in the file. What a person
        opening it would see first, which is also what settles whether the
        columns mean what their names say."""
        lines = self.text().split('\n')[:rows]
        return '\n'.join(line[:200] for line in lines)


def numbered(name: str, n: int) -> str:
    """``words.csv`` as the ``n``th of its name, the way a file manager says
    it: ``words (2).csv``. The suffix stays last, because it is what says how
    the file is read."""
    dot = name.rfind('.')
    if dot <= 0:
        return f'{name} ({n})'
    return f'{name[:dot]} ({n}){name[dot:]}'


class Attachments:
    """Every file attached to one conversation, oldest first.

    Two files may share a name: two tables exported under one name, or a
    corrected table dragged in again. Every one of them has to be reachable by
    the name the model is told, because the model never sees an id. So each is
    given a name of its own when the conversation is read, the way a file
    manager names a second copy: ``words.csv``, then ``words (2).csv``. The
    names go by the order the model was told about the files, and nothing
    later changes an earlier one, so the note written into an old message still
    names the file it was written about.

    A message whose turn failed, was stopped or was lost never reached the
    model, so neither did its note. Its files are named after every file the model has
    been told about: a corrected ``words.csv`` sent as a new message after a
    failed one is the ``words.csv`` the model hears of, not ``words (2).csv``.
    """

    def __init__(self, items: List[Attachment]):
        self.items = items

    @classmethod
    def of(cls, store, conv_id: str, display: List[Dict[str, Any]]) -> 'Attachments':
        """The attachments a conversation's display items refer to.

        Nothing is read here: an Attachment holds the reference and fetches its
        text when something asks. A conversation with files in it that no turn
        ever reads costs one list walk.
        """
        told: Dict[str, Dict[str, Any]] = {}
        untold: Dict[str, Dict[str, Any]] = {}
        items_ = [d for d in display or [] if isinstance(d, dict)]
        for i, item in enumerate(items_):
            if item.get('kind') != 'user':
                continue
            # The model read this message only if the assistant answered it,
            # or it is the last one, the turn being sent. One followed by an
            # error (a failed or stopped turn) or by another user message (a
            # lost turn, whose request went away) never reached it.
            answer = items_[i + 1] if i + 1 < len(items_) else None
            into = told if answer is None or answer.get('kind') == 'assistant' else untold
            for ref in item.get('files') or []:
                if isinstance(ref, dict) and ref.get('id'):
                    into[str(ref['id'])] = ref
        seen = dict(told)
        for file_id, ref in untold.items():
            seen.setdefault(file_id, ref)

        def read_part(file_id: str, n: int) -> Optional[str]:
            key = f'{file_key(store.app, store.project_id, conv_id, file_id)}:part:{n}'
            value = store.read(key)
            return value if isinstance(value, str) else None

        items = [Attachment(ref, read_part) for ref in seen.values()]
        taken = set()
        for a in items:
            name, n = a.name, 2
            while name.casefold() in taken:
                name, n = numbered(a.name, n), n + 1
            a.name = name
            taken.add(name.casefold())
        return cls(items)

    def named(self, refs: List[Dict[str, Any]]) -> List[Attachment]:
        """The attachments among these that one message's refs name, in the
        order the message carries them."""
        by_id = {a.id: a for a in self.items}
        out = []
        for ref in refs or []:
            found = by_id.get(str((ref or {}).get('id')))
            if found is not None:
                out.append(found)
        return out

    def get(self, name: str) -> Attachment:
        """One attachment by the name the note gives it, or by id. Raises
        ValueError naming what there is, which is what the model needs to
        correct itself in one step."""
        wanted = (name or '').strip()
        found = None
        for a in self.items:
            if a.id == wanted or a.name.casefold() == wanted.casefold():
                found = a
                break
        if found is None:
            raise ValueError(f'No file called "{name}" is attached to this conversation. '
                             + (f'Attached: {self.listed()}.' if self.items
                                else 'Nothing is attached to it.'))
        return found

    def listed(self) -> str:
        return ', '.join(f'"{a.name}"' for a in self.items)

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __bool__(self) -> bool:
        return bool(self.items)
