"""Gives sample-raw.pdf bookmarks and printed page labels, as sample.pdf.

Chromium writes neither, and both are what a grammar is navigated by: a
chapter by its bookmark, a page by the number printed on it. The labels are
roman for the front matter and arabic from 1 after it, which is the common
case that makes the PDF's own page count differ from the printed number.

    python plaid-agent/tests/pdf/add_outline.py   (needs pypdf, which only this script uses)
"""

import os

from pypdf import PdfReader, PdfWriter
from pypdf.constants import PageLabelStyle

HERE = os.path.dirname(os.path.abspath(__file__))

reader = PdfReader(os.path.join(HERE, 'sample-raw.pdf'))
writer = PdfWriter()
writer.append(reader)
writer.set_page_label(0, 0, style=PageLabelStyle.LOWERCASE_ROMAN)
writer.set_page_label(1, len(writer.pages) - 1, style=PageLabelStyle.DECIMAL, start=1)
intro = writer.add_outline_item('1 Introduction', 1)
writer.add_outline_item('1.1 Sources', 1, parent=intro)
writer.add_outline_item('2 Phonology', 2)
writer.add_outline_item('3 Complex predicates', 3)
with open(os.path.join(HERE, 'sample.pdf'), 'wb') as f:
    writer.write(f)
os.remove(os.path.join(HERE, 'sample-raw.pdf'))
