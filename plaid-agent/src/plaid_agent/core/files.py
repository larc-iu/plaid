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

A turn can store a file too: a PDF that ``read_url`` fetched is kept as its
text, the way an attached one is (:class:`FileKeeper`). Its reference goes on
the reply, with ``source``, the address it came from, beside the rest.

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

# The most text one file may hold, in UTF-8 bytes. The composer holds an
# attachment to the same figure (MAX_BYTES in plaid-ui's attachments.js), and a
# PDF to it by the text taken out of it rather than by the file.
MAX_FILE_BYTES = 4_000_000

# What one stored value may weigh when the server does not say, and the room
# left under the cap for the key and the store's own rounding. The composer
# cuts with the same two figures.
VALUE_BYTES = 1_000_000

# The files one reply may carry for the user to download (save_file).
MAX_SAVED = 5
VALUE_HEADROOM = 1024


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
        # Where the file came from when a turn fetched it rather than the user
        # attaching it: text from the web, read as such.
        self.source = str(meta.get('source') or '')
        # Made by the assistant (save_file) rather than given to it.
        self.made = bool(meta.get('made'))
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

    def is_pdf(self) -> bool:
        """Whether this is a PDF's text, laid out with page markers. Asked of
        the name first, so a text file is never read to find out."""
        if not self.name.lower().endswith('.pdf'):
            return False
        from .pdftext import has_pages
        return has_pages(self.text().split('\n', 2000)[:2000])

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
            if item.get('kind') == 'assistant':
                # What a turn fetched and stored, which the model has read.
                for ref in item.get('files') or []:
                    if isinstance(ref, dict) and ref.get('id'):
                        told[str(ref['id'])] = ref
                continue
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

        out = cls([])
        for ref in seen.values():
            out.add(Attachment(ref, read_part))
        return out

    def add(self, a: Attachment) -> Attachment:
        """Take one more file, under a name none of the others has."""
        taken = {b.name.casefold() for b in self.items}
        name, n = a.name, 2
        while name.casefold() in taken:
            name, n = numbered(a.name, n), n + 1
        a.name = name
        self.items.append(a)
        return a

    def from_source(self, source: str) -> Optional[Attachment]:
        """The file already stored from this address, if there is one."""
        return next((a for a in self.items if a.source and a.source == source), None)

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


# --- storing a file a turn fetched ------------------------------------------------

def _cost(ch: str) -> int:
    """What the store counts for one character of a stored string. The same
    measure as ``storedBytes`` in plaid-ui's attachments.js: the store escapes
    every non-ASCII character as \\uXXXX (two of them past the BMP), and ``"``,
    ``\\`` and ``/`` with a backslash."""
    o = ord(ch)
    if o > 0xffff:
        return 12
    if o > 0x7e:
        return 6
    if o in (0x22, 0x5c, 0x2f):
        return 2
    if o < 0x20:
        return 2 if o in (0x08, 0x09, 0x0a, 0x0c, 0x0d) else 6
    return 1


def stored_bytes(text: str) -> int:
    return 2 + sum(_cost(ch) for ch in text)


def chunk(text: str, budget: int) -> List[str]:
    """The text cut into parts that each fit one stored value, in order."""
    parts: List[str] = []
    start, cost = 0, 2
    for i, ch in enumerate(text):
        c = _cost(ch)
        if cost + c > budget and i > start:
            parts.append(text[start:i])
            start, cost = i, 2
        cost += c
    parts.append(text[start:])
    return parts


def value_budget(client) -> int:
    """What one stored part may weigh: the server's published cap less the
    room for the key."""
    try:
        cap = (client.server.limits() or {}).get('user_data_value_bytes')
    except Exception:  # noqa: BLE001 - a server that will not say gets the fallback
        cap = None
    return (cap if isinstance(cap, int) and cap > 0 else VALUE_BYTES) - VALUE_HEADROOM


class FileKeeper:
    """Stores the files one turn fetches, beside the conversation, as the
    composer stores an attachment.

    The parts are written as soon as the file is fetched, so a later tool call
    in the same turn reads the file like any other. Their references go on the
    reply (``refs``), which is what makes them the conversation's. A turn that
    fails or is stopped writes no reply, so it deletes what it stored
    (``discard``): nothing would name those parts, and they would sit in the
    store until the conversation went.
    """

    def __init__(self, store, conv_id: str, budget: Optional[int] = None):
        self.store = store
        self.conv_id = conv_id
        self.budget = budget
        self.refs: List[Dict[str, Any]] = []
        self._keys: List[str] = []
        # What this turn saved with save_file, by name folded for case.
        self._made: Dict[str, Attachment] = {}

    def keep(self, files: 'Attachments', name: str, text: str, source: str = '') -> Attachment:
        """Store ``text`` as a file of this conversation and add it to
        ``files``. A file already stored from the same address is that file."""
        if source:
            known = files.from_source(source)
            if known is not None:
                return known
        import uuid
        client = self.store.client
        if self.budget is None:
            self.budget = value_budget(client)
        file_id = str(uuid.uuid4())
        parts = chunk(text, self.budget)
        base = file_key(self.store.app, self.store.project_id, self.conv_id, file_id)
        for n, part in enumerate(parts):
            key = f'{base}:part:{n}'
            client.user_data.put(self.store.user_id, key, part)
            self._keys.append(key)
        lines = text.count('\n') + (0 if text.endswith('\n') or not text else 1)
        ref = {'id': file_id, 'name': name, 'bytes': len(text.encode('utf-8')), 'lines': lines,
               'chunks': len(parts)}
        if source:
            ref['source'] = source
        a = Attachment(ref, lambda fid, n: None)
        a._text = text
        files.add(a)
        # The name the model is told, which `Attachments.of` gives it again
        # from the same order when the conversation is next read.
        self.refs.append({**ref, 'name': name})
        return a

    def save(self, files: 'Attachments', name: str, text: str) -> Attachment:
        """Store ``text`` as a file this turn MADE for the user (``save_file``),
        which the reply carries for them to download and later turns read like
        an attachment. Saving a name this turn already saved replaces that
        file, so code run again after a fix leaves one file, not two. The name
        is the one asked for or the one it was saved as, which differ when it
        clashed with an attachment."""
        earlier = self._made.get(name.casefold())
        if earlier is None and len({id(a) for a in self._made.values()}) >= MAX_SAVED:
            raise ValueError(f'One reply can carry {MAX_SAVED} files, and this one already has '
                             f'{MAX_SAVED}. Put what is left in one of them.')
        # The earlier file steps aside so the new one takes its name, and comes
        # back if the new one cannot be stored.
        if earlier is not None:
            files.items = [b for b in files.items if b is not earlier]
        try:
            a = self.keep(files, name, text)
        except Exception:
            if earlier is not None:
                files.items.append(earlier)
            raise
        if earlier is not None:
            self._drop(files, earlier)
        a.made = True
        self.refs[-1]['made'] = True
        self._made[name.casefold()] = a
        self._made[a.name.casefold()] = a
        return a

    def _drop(self, files: 'Attachments', a: Attachment) -> None:
        prefix = file_key(self.store.app, self.store.project_id, self.conv_id, a.id) + ':part:'
        for key in [k for k in self._keys if k.startswith(prefix)]:
            try:
                self.store.client.user_data.delete(self.store.user_id, key)
            except Exception:  # noqa: BLE001 - what is left goes with the conversation
                pass
            self._keys.remove(key)
        self.refs = [r for r in self.refs if r['id'] != a.id]
        files.items = [b for b in files.items if b is not a]
        self._made = {k: v for k, v in self._made.items() if v is not a}

    def discard(self) -> None:
        for key in self._keys:
            try:
                self.store.client.user_data.delete(self.store.user_id, key)
            except Exception:  # noqa: BLE001 - what is left goes with the conversation
                pass
        self._keys = []
        self.refs = []
        self._made = {}
