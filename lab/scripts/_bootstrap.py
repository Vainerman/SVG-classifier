"""Make `iconlab` importable when running scripts without `pip install -e .`."""
import sys
from pathlib import Path

_LAB_ROOT = Path(__file__).resolve().parent.parent
if str(_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_LAB_ROOT))
