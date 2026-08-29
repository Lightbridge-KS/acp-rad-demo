"""Model selection from the environment.

RAD_MODEL           LangChain provider string, e.g. ``openai:gpt-5.6-terra`` or
                    ``anthropic:claude-sonnet-5``.
RAD_MODEL_BASE_URL  If set, the model name after the ``provider:`` prefix is served through
                    ``ChatOpenAI(base_url=…)`` — any OpenAI-compatible endpoint (Ollama, gateways).
OPENAI_API_KEY      Used with a base URL; falls back to ``"ollama"`` (Ollama ignores it).

The base URL is pinned here on purpose; never read ``OLLAMA_HOST``.
"""

from __future__ import annotations

import os

from langchain_core.language_models import BaseChatModel

DEFAULT_MODEL = "openai:gpt-5.6-terra"


def model_spec() -> str:
    """Return the configured model spec string (for display and logging)."""
    return os.environ.get("RAD_MODEL", DEFAULT_MODEL)


def resolve_model() -> str | BaseChatModel:
    """Return what ``create_deep_agent(model=...)`` should receive.

    A provider string lets deepagents apply its provider profile; a constructed
    ``ChatOpenAI`` instance bypasses that and targets a custom OpenAI-compatible endpoint.
    """
    spec = model_spec()
    base_url = os.environ.get("RAD_MODEL_BASE_URL")
    if not base_url:
        return spec

    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr

    model_name = spec.split(":", 1)[1] if ":" in spec else spec
    return ChatOpenAI(
        model=model_name,
        base_url=base_url,
        api_key=SecretStr(os.environ.get("OPENAI_API_KEY", "ollama")),
        use_responses_api=False,  # chat/completions is the widely supported shape
    )
