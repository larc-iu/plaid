"""Where the reference data lives.

Two kinds of data ship with dig4el:

* Catalog data committed with the package under ``plaid_dig4el/data``: the
  questionnaires with their concept graphs, the concept ontology, per-language
  word delimiters, and questionnaire titles. A few megabytes.
* Derived typological data (WALS and Grambank lookup tables and the
  conditional-probability tables), about 100 MB of JSON. Not committed.
  ``scripts/fetch_reference_data.py`` populates ``plaid-dig4el/reference_data``
  from the dig4el repository; ``PLAID_DIG4EL_REFERENCE_DIR`` points anywhere else.
"""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PACKAGE_DIR / "data"
QUESTIONNAIRES_DIR = DATA_DIR / "questionnaires"

_DEFAULT_REFERENCE_DIR = PACKAGE_DIR.parent.parent / "reference_data"


def reference_dir() -> Path:
    override = os.environ.get("PLAID_DIG4EL_REFERENCE_DIR")
    path = Path(override) if override else _DEFAULT_REFERENCE_DIR
    if not path.is_dir():
        raise FileNotFoundError(
            f"Reference data directory not found: {path}. Run scripts/fetch_reference_data.py "
            "or set PLAID_DIG4EL_REFERENCE_DIR."
        )
    return path
