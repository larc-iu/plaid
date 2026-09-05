#!/usr/bin/env python3
"""Populate ``reference_data/`` with the derived typological tables from the dig4el
repository (WALS and Grambank lookup tables, conditional-probability tables, the
cross-database tables and the parameter topics). About 100 MB.

    python scripts/fetch_reference_data.py [--dest DIR] [--ref GIT_REF]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = "https://github.com/alterfero/dig4el.git"
PATHS = [
    "external_data/wals_derived",
    "external_data/grambank_derived",
    "external_data/glottolog_derived",
    "external_data/grambank_given_wals_cpt.json",
    "external_data/wals_given_grambank_cpt.json",
    "external_data/params_by_topic.json",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parent.parent / "reference_data"))
    ap.add_argument("--ref", default="main")
    args = ap.parse_args()
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", args.ref,
                        REPO, tmp], check=True)
        subprocess.run(["git", "-C", tmp, "sparse-checkout", "set", *PATHS], check=True)
        for rel in PATHS:
            src = Path(tmp) / rel
            target = dest / Path(rel).name
            if src.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(src, target, ignore=shutil.ignore_patterns("experimental_cpt"))
            else:
                shutil.copy2(src, target)
            print("fetched", target)
    print("done:", dest)


if __name__ == "__main__":
    main()
