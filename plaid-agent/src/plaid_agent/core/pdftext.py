"""A PDF's text, laid out as a person reads the page, with its pages and
sections marked so that a reader can find "§9" or "page 41" without reading
the rest.

Two producers write this text and one reader reads it. ``read_url`` extracts
a PDF it fetched here, with PDFium (:func:`extract`). The chat's composer
extracts one the user attached in the browser, with pdf.js
(``plaid-ui/src/components/assistant/pdfText.js``). Both store the result as an
ordinary attachment, and ``read_file`` finds pages and sections in it with
:func:`page_span` and :func:`section_span`. So everything below the extraction
itself (how a page is laid out from positioned text, how the text is cleaned,
how the markers are written, when a PDF counts as a scan) exists twice, and
``tests/test_pdf_mirror.py`` runs the two over the same input.

The markers are lines of their own::

    === # 9 Complex predicates ===
    === ## 9.1 Aspect and modality ===
    === page 184 (PDF page 29) ===

A section marker comes from the PDF's bookmarks and stands before the marker
of the page the section begins on. A page marker gives the number printed on
the page where the PDF says what that is, and the PDF's own count beside it
when the two differ, since a grammar is cited by its printed numbers.

Why a layout of our own rather than the library's plain text: a linguistic
example is often set in columns, a line of forms over a line that translates
them word by word, and plain extraction joins each line with single spaces, so
which word stands under which is lost whenever one is wider than the other.
Here a run of text after a wide gap is put at the column its position on the
page gives, so the two lines of an example line up as they do on paper, while
ordinary prose keeps single spaces.
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import regex

# --- the numbers both producers use ---------------------------------------------

#: A page with fewer non-space characters than this has no text to speak of.
EMPTY_PAGE_CHARS = 20

#: Gaps between two runs on a line, as a share of the font size. Below JOIN the
#: two are one word (a small-capitals "3SG" is set as "3" and then a smaller "sg");
#: below SPACE they are two words; past it the second run is placed at its
#: column.
JOIN_GAP = 0.15
SPACE_GAP = 0.8

#: The join gap between two letters of a right-to-left script.
RTL_JOIN_GAP = 0.3

#: The widest gap a drawn space may fill and still be a word space, as a share
#: of the font size. Past it the space is followed by a tab or a column.
WORD_GAP = 0.5

#: How close the starts of two runs on neighbouring lines must be, as a share
#: of the font size, for the two to be in one column.
ALIGNED = 0.15

#: How far apart two baselines may be, as a share of the larger font size, and
#: still be one line. A superscript sits about a third of a size up.
SAME_LINE = 0.5

#: A gap between two lines wider than this many font sizes is a blank line.
BLANK_LINE = 1.6

#: Bookmarks kept. A book's outline is a few hundred entries.
MAX_SECTIONS = 2000

#: Deepest heading level written. Deeper bookmarks are written at this level.
MAX_DEPTH = 6

# --- cleaning ---------------------------------------------------------------------

# Typographic ligatures, which some fonts map to their own code points. Each is
# replaced by its letters and nothing else is folded: NFKC would also turn a
# superscript ʰ into h and a modifier apostrophe into a quote, which are
# distinctions a transcription makes on purpose.
LIGATURES = {
    '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi',
    '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st',
}

# A spacing accent written before its letter, which is how a TeX accent comes
# out of a font with no combining marks. Each becomes the combining mark after
# the letter, and NFC then composes the two where Unicode has one character.
SPACING_ACCENTS = {
    '\u00b4': '\u0301', '\u00a8': '\u0308', '\u02dc': '\u0303', '\u02c6': '\u0302',
    '\u02c7': '\u030c', '\u02d8': '\u0306', '\u00af': '\u0304', '\u02d9': '\u0307',
    '\u02da': '\u030a',
}

_ACCENT_RE = regex.compile('([' + ''.join(SPACING_ACCENTS) + r'])(\p{L})')
# A combining mark set apart from its letter by a space, which is how a mark
# placed over a letter as a glyph of its own comes out.
_LOOSE_MARK_RE = regex.compile(r'(\S)[ \t]+([\u0300-\u036f\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f])')
# Arabic presentation forms, the shaped letters some PDFs carry instead of the
# letters themselves. These alone are folded with NFKC, which gives the letter.
_PRESENTATION_RE = regex.compile(r'[\ufb50-\ufdff\ufe70-\ufeff]')
_BLANKS_RE = re.compile(r'\n{3,}')


def clean(text: str) -> str:
    """Page text as it should be stored: ligatures spelled out, accents put
    back on their letters, Arabic presentation forms folded to letters, NFC,
    no trailing spaces, and no run of blank lines."""
    if not text:
        return ''
    for lig, letters in LIGATURES.items():
        text = text.replace(lig, letters)
    text = _PRESENTATION_RE.sub(lambda m: unicodedata.normalize('NFKC', m.group(0)), text)
    text = _ACCENT_RE.sub(lambda m: m.group(2) + SPACING_ACCENTS[m.group(1)], text)
    text = _LOOSE_MARK_RE.sub(r'\1\2', text)
    text = unicodedata.normalize('NFC', text)
    text = '\n'.join(line.rstrip() for line in text.split('\n'))
    return _BLANKS_RE.sub('\n\n', text).strip('\n')


# --- direction --------------------------------------------------------------------

def _rtl(ch: str) -> bool:
    o = ord(ch)
    return 0x0590 <= o <= 0x08ff or 0xfb1d <= o <= 0xfdff or 0xfe70 <= o <= 0xfeff


def _ltr(ch: str) -> bool:
    return ch.isalpha() and not _rtl(ch)


def is_rtl(text: str) -> bool:
    """Whether a run of text is mostly right-to-left letters."""
    r = sum(1 for ch in text if _rtl(ch))
    return r > 0 and r >= sum(1 for ch in text if _ltr(ch))


def logical(visual: str) -> str:
    """A right-to-left run written in visual order (left to right on the
    page, which is how PDF producers draw it), in the order it is read.
    Numbers and Latin inside it are read left to right, so they keep their
    own order and only their place in the run changes."""
    parts = regex.findall(r'[0-9A-Za-z.,:]+|[^0-9A-Za-z.,:]', visual)
    out = []
    for part in reversed(parts):
        out.append(part)
    return ''.join(out)


# --- laying a page out ------------------------------------------------------------

def _round(x: float) -> int:
    """Round half away from zero, as JavaScript's Math.round does for the
    positive numbers this is used on, so both producers place a run in the same
    column."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def layout(runs: Sequence[Dict[str, Any]]) -> str:
    """One page's text from its runs of positioned text.

    A run is ``{text, x0, x1, y, size}``: its text in reading order, where it
    starts and ends across the page, its baseline (PDF space, so up is
    larger), and its font size. Runs are grouped into lines by baseline. In a
    line read left to right, a run close to the one before joins it with one
    space or none, and one after a wide gap is placed at the column its
    position gives, which is what keeps an example's columns, and
    so is one that begins where a run on the line above or below begins. A
    line that is mostly right-to-left is read from the right, with single
    spaces.
    """
    runs = [r for r in runs if (r.get('text') or '').strip()]
    if not runs:
        return ''
    chars = sum(len(r['text']) for r in runs)
    width = sum(max(0.0, r['x1'] - r['x0']) for r in runs)
    cw = width / chars if chars and width > 0 else 5.0
    left = min(r['x0'] for r in runs)

    lines: List[Dict[str, Any]] = []
    for r in sorted(runs, key=lambda r: (-r['y'], r['x0'])):
        line = lines[-1] if lines else None
        if line is not None and abs(line['y'] - r['y']) <= SAME_LINE * max(line['size'], r['size']):
            line['runs'].append(r)
            line['size'] = max(line['size'], r['size'])
        else:
            lines.append({'y': r['y'], 'size': r['size'], 'runs': [r]})

    out: List[str] = []
    prev_y = None
    prev_size = 0.0
    for k, line in enumerate(lines):
        # Where the runs of the lines above and below begin: a run that
        # begins where one of theirs does is in a column with it.
        line['beside'] = [r['x0'] for j in (k - 1, k + 1) if 0 <= j < len(lines)
                          for r in lines[j]['runs']]
    for line in lines:
        if prev_y is not None and prev_y - line['y'] > BLANK_LINE * max(prev_size, line['size']):
            out.append('')
        prev_y, prev_size = line['y'], line['size']
        text = ''.join(r['text'] for r in line['runs'])
        if is_rtl(text):
            out.append(_rtl_line(line['runs']))
        else:
            out.append(_ltr_line(line['runs'], left, cw, line['beside']))
    return '\n'.join(out)


_SMALL_CAPS_RE = regex.compile(r'^[\p{Ll}.\-]*\p{Ll}[\p{Ll}.\-]*$')


def _small_caps(runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Runs with small capitals written as capitals.

    A word processor or a browser makes small capitals by setting lower-case
    letters in capital shapes at a smaller size, and the PDF says the letters
    are the lower-case ones, so "3SG" comes out as "3sg". Lower-case
    letters set smaller than the run they touch, on the same baseline, are
    such letters. A superscript is smaller too, but raised, and a word in a
    smaller font on its own touches nothing.
    """
    out = [dict(r) for r in runs]
    for i, r in enumerate(out):
        if not _SMALL_CAPS_RE.match(r['text']):
            continue
        for j in (i - 1, i + 1):
            if not 0 <= j < len(runs):
                continue
            n = runs[j]
            gap = r['x0'] - n['x1'] if j < i else n['x0'] - r['x1']
            if (r['size'] < 0.85 * n['size'] and gap < JOIN_GAP * n['size']
                    and abs(r['y'] - n['y']) <= 0.15 * n['size']):
                r['text'] = r['text'].upper()
                break
    return out


def _ltr_line(runs, left: float, cw: float, beside: Sequence[float] = ()) -> str:
    runs = _small_caps(sorted(runs, key=lambda r: r['x0']))
    out = ''
    width = 0  # code points so far, which is what a column counts
    prev = None
    for r in runs:
        if prev is None:
            pad = max(0, _round((r['x0'] - left) / cw))
        else:
            gap = r['x0'] - prev['x1']
            size = max(prev['size'], r['size'])
            aligned = any(abs(r['x0'] - x) <= ALIGNED * size for x in beside)
            if gap < JOIN_GAP * size:
                pad = 0
            elif gap < SPACE_GAP * size and not aligned:
                pad = 1
            else:
                pad = max(2 if gap >= SPACE_GAP * size else 1, _round((r['x0'] - left) / cw) - width)
        out += ' ' * pad + r['text']
        width += pad + len(r['text'])
        prev = r
    return out


def _rtl_line(runs) -> str:
    runs = sorted(runs, key=lambda r: -r['x1'])
    out = ''
    prev = None
    for r in runs:
        if prev is not None:
            gap = prev['x0'] - r['x1']
            size = max(prev['size'], r['size'])
            out += '' if gap < JOIN_GAP * size else ' ' if gap < SPACE_GAP * size else '  '
        out += r['text']
        prev = r
    return out


# --- the whole document ------------------------------------------------------------

_MARKER_RE = re.compile(r'^=== (?:page (.+?)(?: \(PDF page (\d+)\))?|(#{1,6}) (.*)) ===$')


def page_marker(index: int, label: str = '') -> str:
    n = index + 1
    label = ' '.join((label or '').split())
    if not label or label == str(n):
        return f'=== page {n} ==='
    return f'=== page {label} (PDF page {n}) ==='


def section_marker(depth: int, title: str) -> str:
    title = clean(' '.join((title or '').split())).replace('===', '= = =')
    return f'=== {"#" * max(1, min(MAX_DEPTH, depth))} {title} ==='


def _defused(text: str) -> str:
    """Page text with any line of its own that reads as a marker taken apart,
    so a page cannot pretend to start another one."""
    return '\n'.join(line.replace('===', '= = =') if _MARKER_RE.match(line) else line
                     for line in text.split('\n'))


def assemble(pages: Sequence[str], labels: Sequence[str] = (),
             sections: Sequence[Tuple[int, str, int]] = ()) -> str:
    """The stored text: each page's text after its marker, and each section's
    marker before the page it begins on. ``sections`` is ``(depth, title,
    page index)`` from the bookmarks, depth counted from 1, in outline order."""
    starting: Dict[int, List[Tuple[int, str]]] = {}
    for depth, title, index in list(sections)[:MAX_SECTIONS]:
        if isinstance(index, int) and 0 <= index < len(pages) and (title or '').strip():
            starting.setdefault(index, []).append((depth, title))
    out: List[str] = []
    for i, text in enumerate(pages):
        for depth, title in starting.get(i, []):
            out.append(section_marker(depth, title))
        out.append(page_marker(i, labels[i] if i < len(labels) else ''))
        if text:
            out.append(_defused(text))
    return '\n'.join(out) + '\n' if out else ''


def empty_pages(pages: Sequence[str]) -> int:
    """How many pages have no text to speak of."""
    return sum(1 for p in pages if len(''.join((p or '').split())) < EMPTY_PAGE_CHARS)


def is_scan(pages: Sequence[str]) -> bool:
    """A PDF with no text layer to read: no pages, or more than half of them
    empty. What that usually means is a scan, pictures of pages."""
    return not pages or empty_pages(pages) * 2 > len(pages)


# --- extracting, with PDFium --------------------------------------------------------

class PdfError(Exception):
    """A PDF that cannot be read, in a sentence for the model to pass on."""


@dataclass
class PdfText:
    text: str
    pages: int
    sections: List[Tuple[int, str, int]] = field(default_factory=list)
    empty: int = 0
    scan: bool = False


def runs_from_items(items: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Runs of text from the pieces a library reports, in the order the page
    draws them: ``{text, x0, x1, y, size}`` each, a piece being a character
    (PDFium) or a string drawn in one go (pdf.js). Consecutive pieces on one
    baseline, in one size, are one run when the next starts where the last
    ended, or after a space the page draws that is no wider than a word space.
    A wider gap is a tab or a column, and starts a run of its own for the
    layout to place. A right-to-left run, drawn left to right, is turned round
    to the order it is read in."""
    runs: List[Dict[str, Any]] = []
    cur: Optional[Dict[str, Any]] = None
    space = False

    def close():
        if cur is not None:
            text = cur['text']
            runs.append({**cur, 'text': logical(text) if is_rtl(text) else text})

    for it in items:
        raw_text = it.get('text') or ''
        text = raw_text.strip()
        if not text:
            space = space or cur is not None
            continue
        if raw_text[0].isspace() and cur is not None:
            space = True
        size = float(it['size']) or 1.0
        x0, x1, y = float(it['x0']), float(it['x1']), float(it['y'])
        gap = x0 - cur['x1'] if cur is not None else 0.0
        # Joined letters of a right-to-left script are reported with more
        # room between them than their shapes leave on the page.
        join = RTL_JOIN_GAP if cur is not None and _rtl(cur['text'][-1]) and _rtl(text[0]) else JOIN_GAP
        if (cur is not None and abs(cur['y'] - y) <= 0.2 * max(cur['size'], size)
                and abs(cur['size'] - size) <= 0.01 * max(cur['size'], size)
                and gap >= -0.5 * size
                and (gap < join * size or (space and gap < WORD_GAP * size))):
            cur['text'] += (' ' if space else '') + text
            cur['x1'] = max(cur['x1'], x1)
        else:
            close()
            cur = {'text': text, 'x0': x0, 'x1': x1, 'y': y, 'size': size}
        space = raw_text[-1].isspace()
    close()
    return runs


def _items_from_chars(textpage, raw) -> List[Dict[str, Any]]:
    """PDFium's characters as pieces for :func:`runs_from_items`: each with
    its advance (the loose box, not the ink, so two letters of a word touch)
    and its size on the page. Turned text (a line number up the margin) is
    left out, as it is not part of any line."""
    import ctypes
    n = textpage.count_chars()
    x = ctypes.c_double()
    y = ctypes.c_double()
    box = raw.FS_RECTF()
    m = raw.FS_MATRIX()
    out: List[Dict[str, Any]] = []
    for i in range(n):
        if raw.FPDFText_IsGenerated(textpage, i) == 1:
            continue
        code = raw.FPDFText_GetUnicode(textpage, i)
        if code in (0, 0x02, 0x0a, 0x0d, 0xfffe, 0xffff):
            continue
        raw.FPDFText_GetMatrix(textpage, i, m)
        # Turned text has a rotation in it. A slant alone (an oblique made
        # from an upright font) is still on the line.
        if abs(m.b) > 0.01 * abs(m.a or 1):
            continue
        raw.FPDFText_GetCharOrigin(textpage, i, x, y)
        raw.FPDFText_GetLooseCharBox(textpage, i, box)
        size = float(raw.FPDFText_GetFontSize(textpage, i)) * abs(m.d or 1.0)
        out.append({'text': chr(code), 'x0': float(box.left), 'x1': float(box.right),
                    'y': float(y.value), 'size': size})
    return out


def _sections(doc) -> List[Tuple[int, str, int]]:
    out = []
    try:
        for item in doc.get_toc(max_depth=MAX_DEPTH * 3):
            dest = item.get_dest()
            index = dest.get_index() if dest is not None else None
            title = item.get_title() or ''
            if index is not None and title.strip():
                out.append((item.level + 1, title, int(index)))
            if len(out) >= MAX_SECTIONS:
                break
    except Exception:  # noqa: BLE001 - a broken outline is no outline; the pages still read
        return []
    return out


def extract(data: bytes, on_page=None) -> PdfText:
    """The text of a PDF, laid out and marked. Raises :class:`PdfError`.
    ``on_page(done, total)`` is told as pages are read, for progress."""
    try:
        import pypdfium2 as pdfium
        import pypdfium2.raw as raw
    except ImportError:  # pragma: no cover - the package requires it
        raise PdfError('This assistant cannot read PDFs: the PDF library is not installed.')
    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        if 'password' in str(e).lower():
            raise PdfError('It is a PDF locked with a password, so it cannot be read.')
        raise PdfError('It is not a PDF that can be opened (the file is damaged or not a PDF).')
    try:
        total = len(doc)
        pages: List[str] = []
        labels: List[str] = []
        for i in range(total):
            page = doc[i]
            try:
                textpage = page.get_textpage()
                try:
                    pages.append(clean(layout(runs_from_items(_items_from_chars(textpage, raw)))))
                finally:
                    textpage.close()
            finally:
                page.close()
            try:
                labels.append(doc.get_page_label(i) or '')
            except Exception:  # noqa: BLE001 - no label is the PDF's own count
                labels.append('')
            if on_page is not None:
                on_page(i + 1, total)
        sections = _sections(doc)
    finally:
        doc.close()
    return PdfText(text=assemble(pages, labels, sections), pages=total, sections=sections,
                   empty=empty_pages(pages), scan=is_scan(pages))


# --- reading it back ------------------------------------------------------------------

@dataclass
class Marker:
    line: int            # 0-based line index
    kind: str            # 'page' or 'section'
    label: str = ''      # a page's printed number, or a section's title
    number: int = 0      # a page's place in the PDF
    depth: int = 0       # a section's level


def markers(lines: Sequence[str]) -> List[Marker]:
    out = []
    for i, line in enumerate(lines):
        if not line.startswith('=== '):
            continue
        m = _MARKER_RE.match(line)
        if not m:
            continue
        if m.group(3):
            out.append(Marker(i, 'section', m.group(4), depth=len(m.group(3))))
        else:
            label = m.group(1)
            number = int(m.group(2)) if m.group(2) else (int(label) if label.isdigit() else 0)
            out.append(Marker(i, 'page', label, number=number))
    return out


def has_pages(lines: Sequence[str]) -> bool:
    return any(m.kind == 'page' for m in markers(lines))


def _page_end(lines: Sequence[str], marks: List[Marker], page_at: int) -> int:
    """The last line of the page whose marker is at ``page_at``: the line
    before the next page's marker and the section markers in front of it."""
    later = [m for m in marks if m.kind == 'page' and m.line > page_at]
    if not later:
        return len(lines) - 1
    end = later[0].line - 1
    starts = {m.line for m in marks if m.kind == 'section'}
    while end > page_at and end in starts:
        end -= 1
    return end


def _find_page(marks: List[Marker], wanted: str) -> Optional[Marker]:
    pages = [m for m in marks if m.kind == 'page']
    w = wanted.strip().casefold()
    for m in pages:
        if m.label.casefold() == w:
            return m
    if w.isdigit():
        for m in pages:
            if m.number == int(w):
                return m
    return None


def page_span(lines: Sequence[str], page: str) -> Tuple[int, int, str]:
    """``(first line, last line, what)`` for a page or a range of pages,
    ``"41"`` or ``"41-45"``, by the number printed on the page first and the
    PDF's own count second. Raises ValueError saying what pages there are."""
    marks = markers(lines)
    if not any(m.kind == 'page' for m in marks):
        raise ValueError('it has no page markers, so it is read by line')
    wanted = str(page).strip()
    parts = re.split(r'\s*[-–]\s*', wanted, maxsplit=1) if not wanted.startswith('-') else [wanted]
    first = _find_page(marks, parts[0])
    last = _find_page(marks, parts[1]) if len(parts) > 1 else first
    pages = [m for m in marks if m.kind == 'page']
    if first is None or last is None:
        raise ValueError(f'it has no page {wanted}. Its pages run from {pages[0].label} to '
                         f'{pages[-1].label}')
    if last.line < first.line:
        first, last = last, first
    starts = {m.line for m in marks if m.kind == 'section'}
    start = first.line
    # The section markers in front of the first page belong to it.
    while start - 1 in starts:
        start -= 1
    what = f'page {first.label}' if first is last else f'pages {first.label}–{last.label}'
    return start, _page_end(lines, marks, last.line), what


_NUMBER_RE = re.compile(r'^§?\s*(\d+(?:\.\d+)*)\.?$')


def _title_number(title: str) -> str:
    words = title.strip().split(None, 1)
    return words[0].rstrip('.').lstrip('§') if words else ''


def _successors(number: str) -> List[str]:
    """The numbers of the headings that can follow section ``number`` and end
    it: its next sibling, and the next sibling of each section above it."""
    parts = [int(p) for p in number.split('.')]
    out = []
    for k in range(len(parts), 0, -1):
        nxt = parts[:k - 1] + [parts[k - 1] + 1]
        out.append('.'.join(str(p) for p in nxt))
    return out


def section_span(lines: Sequence[str], section: str) -> Tuple[int, int, str]:
    """``(first line, last line, what)`` for a section, by its number
    (``"9"``, ``"§9.2"``) or a piece of its title, from the bookmarks' markers
    where there are any and from the headings in the text where there are not.
    It runs from its own heading to the next section's at its level or above,
    on the pages where the text shows those headings, and from the page it
    begins on to the end of the page the next one begins on where it does not.
    Raises ValueError."""
    q = ' '.join(str(section or '').split())
    if not q:
        raise ValueError('say which section')
    marks = markers(lines)
    sections = [m for m in marks if m.kind == 'section']
    num = _NUMBER_RE.match(q)
    number = num.group(1) if num else None
    if sections:
        hit = None
        if number:
            hit = next((m for m in sections if _title_number(m.label) == number), None)
        if hit is None:
            hit = next((m for m in sections if q.casefold().lstrip('§ ') in m.label.casefold()), None)
        if hit is None:
            listed = '; '.join(m.label for m in sections if m.depth == 1)[:600]
            raise ValueError(f'no section matches "{q}". Its top-level sections: {listed}')
        nxt = next((m for m in sections if m.line > hit.line and m.depth <= hit.depth), None)
        end = len(lines) - 1
        if nxt is not None:
            page = next((m for m in marks if m.kind == 'page' and m.line > nxt.line), None)
            if page is not None:
                # It ends on the page the next one begins on, at the next
                # one's heading where the page shows it, and at the end of
                # that page where it does not.
                end = _page_end(lines, marks, page.line)
                heading = _heading_line(lines, page.line, end, nxt.label)
                if heading is not None:
                    end = heading - 1
                    while end > hit.line and (not lines[end].strip() or _MARKER_RE.match(lines[end])):
                        end -= 1
        # It begins at its own heading where its first page shows it below
        # the end of the section before, rather than with that end.
        first = next((m for m in marks if m.kind == 'page' and m.line > hit.line), None)
        if first is not None:
            heading = _heading_line(lines, first.line, _page_end(lines, marks, first.line), hit.label)
            before = [i for i in range(first.line + 1, heading or first.line) if lines[i].strip()]
            # One line above it is a running header, not another section.
            if heading is not None and len(before) > 1 and heading <= end:
                return heading, end, f'section "{hit.label}", from page {first.label}'
        return hit.line, end, f'section "{hit.label}"'
    return _section_from_headings(lines, q, number)


def _same_heading(line: str, title: str) -> bool:
    """Whether a line of text is the heading a bookmark names: the same
    words, whatever the spacing, the case, or a full stop after its number."""
    def norm(s):
        words = s.split()
        if words:
            words[0] = words[0].rstrip('.')
        return ' '.join(words).casefold()
    return bool(line.strip()) and norm(line) == norm(title)


def _heading_line(lines: Sequence[str], page_at: int, end: int, title: str) -> Optional[int]:
    """The line on the page whose marker is at ``page_at`` (up to ``end``)
    that is the heading ``title``, if the page shows it."""
    return next((i for i in range(page_at + 1, end + 1) if _same_heading(lines[i], title)), None)


_TOC_LINE_RE = re.compile(r'(\.{3,}|…|\s\d+\s*$)')


def _heading_at(line: str, number: str) -> bool:
    s = line.strip()
    if len(s) > 100 or _TOC_LINE_RE.search(s):
        return False
    return bool(regex.match(r'§?\s*' + re.escape(number) + r'\.?\s+\p{L}', s))


def _section_from_headings(lines: Sequence[str], q: str, number: Optional[str]) -> Tuple[int, int, str]:
    """A section found by its heading in the text, for a PDF without
    bookmarks. A contents page lists the same headings with page numbers
    after them, and a line like that is not the heading."""
    if number is None:
        start = next((i for i, line in enumerate(lines)
                      if q.casefold() in line.casefold() and len(line.strip()) <= 100
                      and not _TOC_LINE_RE.search(line.strip()) and not _MARKER_RE.match(line)), None)
        if start is None:
            raise ValueError(f'it has no bookmarks and no heading containing "{q}". '
                             'Ask for a page instead')
        return start, len(lines) - 1, f'the heading "{lines[start].strip()}"'
    start = next((i for i, line in enumerate(lines) if _heading_at(line, number)), None)
    if start is None:
        raise ValueError(f'it has no bookmarks and no heading numbered {number}. Ask for a page instead')
    after = _successors(number)
    end = next((i - 1 for i in range(start + 1, len(lines))
                if any(_heading_at(lines[i], n) for n in after)), len(lines) - 1)
    return start, end, f'section "{lines[start].strip()}"'


def contents(lines: Sequence[str], limit: int = 60) -> List[str]:
    """The section markers as a contents list, each with the page it begins
    on, the top levels first when there are more than ``limit``."""
    marks = markers(lines)
    sections = [m for m in marks if m.kind == 'section']
    if not sections:
        return []
    depth = MAX_DEPTH
    while depth > 1 and sum(1 for m in sections if m.depth <= depth) > limit:
        depth -= 1
    shown = [m for m in sections if m.depth <= depth]
    out = []
    for m in shown[:limit]:
        page = next((p for p in marks if p.kind == 'page' and p.line > m.line), None)
        at = f' (page {page.label})' if page else ''
        out.append(f'{"  " * (m.depth - 1)}{m.label}{at}')
    if len(sections) > len(out):
        out.append(f'… and {len(sections) - len(out)} more')
    return out


def page_count(lines: Sequence[str]) -> int:
    return sum(1 for m in markers(lines) if m.kind == 'page')
