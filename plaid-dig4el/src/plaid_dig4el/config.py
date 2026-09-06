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
    # The language-model endpoint: any OpenAI-compatible URL (a litellm proxy, typically).
    # Nothing is assumed: the URL, the key (LLM_API_KEY or the first line of the key
    # file) and the model names are given at launch. Without them the app runs, and the
    # features that need a model say so.
    llm_base_url: str = field(default_factory=lambda: _env("LLM_BASE_URL", ""))
    llm_api_key: str = field(default_factory=lambda: _env("LLM_API_KEY", ""))
    llm_key_file: str = field(default_factory=lambda: _env("LLM_KEY_FILE", ""))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL", ""))  # structured stages
    llm_model_strong: str = field(default_factory=lambda: _env("LLM_MODEL_STRONG", ""))  # optional, offered as "strong"
    llm_embedding_model: str = field(default_factory=lambda: _env("LLM_EMBEDDING_MODEL", ""))

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

    def llm_key(self) -> str:
        if self.llm_api_key:
            return self.llm_api_key
        if self.llm_key_file:
            path = Path(self.llm_key_file).expanduser()
            if path.exists():
                return path.read_text().strip().splitlines()[0].strip()
        return ""

    def llm_missing(self) -> list[str]:
        """What the language-model setup lacks, in the words of the flags."""
        out = []
        if not self.llm_base_url:
            out.append("--llm-url")
        if not self.llm_key():
            out.append("--llm-key-file (or LLM_API_KEY)")
        if not self.llm_model:
            out.append("--llm-model")
        if not self.llm_embedding_model:
            out.append("--llm-embedding-model")
        return out


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def configure(s: Settings) -> None:
    global _settings
    _settings = s
