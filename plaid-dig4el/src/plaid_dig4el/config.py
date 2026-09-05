"""Server settings, from the command line or the environment."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    plaid_url: str = field(default_factory=lambda: _env("PLAID_URL", "http://localhost:8085"))
    data_dir: Path = field(default_factory=lambda: Path(_env("PLAID_DIG4EL_DATA_DIR", "./data")))
    host: str = field(default_factory=lambda: _env("PLAID_DIG4EL_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(_env("PLAID_DIG4EL_PORT", "8087")))
    secret_key: str = field(default_factory=lambda: _env("PLAID_DIG4EL_SECRET", ""))
    dev_reload: bool = False

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.secret_key:
            # A per-installation secret for signing session cookies, created once.
            key_file = self.data_dir / "secret_key"
            if key_file.exists():
                self.secret_key = key_file.read_text().strip()
            else:
                self.secret_key = secrets.token_urlsafe(48)
                key_file.write_text(self.secret_key)
                key_file.chmod(0o600)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "dig4el.db"


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def configure(s: Settings) -> None:
    global _settings
    _settings = s
