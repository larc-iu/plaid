from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_cpt(path: Path) -> pd.DataFrame:
    """A conditional-probability table as a DataFrame with string labels on both axes."""
    cpt = pd.read_json(path)
    cpt.index = cpt.index.astype(str)
    cpt.columns = cpt.columns.astype(str)
    return cpt


def normalize_column(column: pd.Series) -> pd.Series:
    """Scale a column to sum to 1; an all-zero column becomes uniform (no information)."""
    col_sum = column.sum()
    if col_sum == 0:
        return pd.Series([1 / len(column)] * len(column), index=column.index)
    return column / col_sum
