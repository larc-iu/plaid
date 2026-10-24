import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import _comma_aux  # noqa: E402


def setup(ctx):
    _comma_aux.plant(ctx)
