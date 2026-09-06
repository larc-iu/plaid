"""The language-model endpoint: chat with a JSON schema, chat for text, embeddings.

Any OpenAI-compatible server works. Reasoning models return their thinking in a
separate field, which is dropped. ``chat_json`` validates the answer against a
pydantic model and retries once with the validation error shown to the model.
"""

from __future__ import annotations

import json
import time
from typing import Any, TypeVar

import requests
from pydantic import BaseModel, ValidationError

from .config import settings

M = TypeVar("M", bound=BaseModel)


class LLMError(Exception):
    pass


class LLM:
    def __init__(self, base_url: str | None = None, api_key: str | None = None, model: str | None = None,
                 strong_model: str | None = None, embedding_model: str | None = None, timeout: float = 300):
        s = settings()
        self.base_url = (base_url or s.llm_base_url).rstrip("/")
        self.api_key = api_key if api_key is not None else s.llm_key()
        self.model = model or s.llm_model
        self.strong_model = strong_model or s.llm_model_strong
        self.embedding_model = embedding_model or s.llm_embedding_model
        self.timeout = timeout
        self.strong_model = self.strong_model or self.model
        missing = s.llm_missing() if not (base_url or api_key or model or embedding_model) else []
        if missing or not self.base_url or not self.api_key or not self.model:
            raise LLMError("No language-model endpoint is configured. Launch with " + ", ".join(missing or ["--llm-url", "--llm-key-file", "--llm-model", "--llm-embedding-model"]) + ".")

    # ------------------------------------------------------------------ transport

    def _post(self, path: str, body: dict, retries: int = 3) -> dict:
        url = f"{self.base_url}{path}"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        last: Exception | None = None
        for attempt in range(retries):
            try:
                r = requests.post(url, json=body, headers=headers, timeout=self.timeout)
            except requests.RequestException as e:
                last = e
            else:
                if r.status_code < 400:
                    return r.json()
                if r.status_code < 500 and r.status_code != 429:
                    raise LLMError(f"{r.status_code} from {path}: {r.text[:300]}")
                last = LLMError(f"{r.status_code} from {path}: {r.text[:300]}")
            time.sleep(2 ** attempt)
        raise LLMError(f"The language-model endpoint failed after {retries} attempts: {last}")

    # ------------------------------------------------------------------ chat

    def chat_text(self, messages: list[dict], model: str | None = None, max_tokens: int = 4000,
                  temperature: float | None = None) -> str:
        body: dict[str, Any] = {"model": model or self.model, "messages": messages, "max_tokens": max_tokens}
        if temperature is not None:
            body["temperature"] = temperature
        out = self._post("/chat/completions", body)
        choice = out["choices"][0]
        return (choice["message"].get("content") or "").strip()

    def chat_json(self, messages: list[dict], schema: type[M], model: str | None = None,
                  max_tokens: int = 4000, name: str = "answer") -> M:
        """A chat completion constrained to ``schema``, validated by pydantic. One repair
        round on invalid output, then ``LLMError``."""
        body: dict[str, Any] = {
            "model": model or self.model, "messages": list(messages), "max_tokens": max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": name, "schema": schema.model_json_schema(), "strict": True}},
        }
        error = ""
        for attempt in range(2):
            out = self._post("/chat/completions", body)
            choice = out["choices"][0]
            content = (choice["message"].get("content") or "").strip()
            try:
                return schema.model_validate_json(content)
            except ValidationError as e:
                error = str(e)[:1500]
            except ValueError as e:  # not JSON at all
                error = f"{e}: {content[:200]}"
            if choice.get("finish_reason") == "length":
                error = "the answer was cut off (token limit); " + error
            body["messages"] = list(messages) + [
                {"role": "assistant", "content": content},
                {"role": "user", "content": f"That answer did not fit the schema: {error}\nReturn only valid JSON for the schema."},
            ]
        raise LLMError(f"The model's answer did not fit {schema.__name__}: {error}")

    # ------------------------------------------------------------------ embeddings

    def embed(self, texts: list[str], model: str | None = None, batch: int = 64) -> list[list[float]]:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), batch):
            out = self._post("/embeddings", {"model": model or self.embedding_model, "input": texts[i:i + batch]})
            rows = sorted(out["data"], key=lambda d: d.get("index", 0))
            vectors.extend(d["embedding"] for d in rows)
        return vectors


def configured() -> bool:
    """Whether the launch gave an endpoint, a key and the model names."""
    return not settings().llm_missing()


_llm: LLM | None = None


def llm() -> LLM:
    global _llm
    if _llm is None:
        _llm = LLM()
    return _llm
