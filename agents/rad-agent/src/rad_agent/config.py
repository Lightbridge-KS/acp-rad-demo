"""Model selection from the environment.

RAD_MODELS          Comma-separated LangChain provider strings the session may switch
                    between through ACP (``session/set_config_option`` on the ``model``
                    select); the first is the default. Optional.
RAD_MODEL           A single provider string, e.g. ``openai:gpt-5.6-terra`` or
                    ``anthropic:claude-sonnet-5`` — used when ``RAD_MODELS`` is unset.
RAD_MODEL_BASE_URL  If set, the model name after the ``provider:`` prefix is served through
                    ``ChatOpenAI(base_url=…)`` — any OpenAI-compatible endpoint (Ollama, gateways).
                    Global: with a base URL every entry of ``RAD_MODELS`` goes to that endpoint.
OPENAI_API_KEY      Used with a base URL; falls back to ``"ollama"`` (Ollama ignores it).

The base URL is pinned here on purpose; never read ``OLLAMA_HOST``.
"""

from __future__ import annotations

import os

from langchain_core.language_models import BaseChatModel

DEFAULT_MODEL = "openai:gpt-5.6-terra"


def model_specs() -> list[str]:
    """Every model the agent offers, default first; never empty."""
    raw = os.environ.get("RAD_MODELS", "")
    specs = [s.strip() for s in raw.split(",") if s.strip()]
    return specs or [os.environ.get("RAD_MODEL", DEFAULT_MODEL)]


def model_spec() -> str:
    """The default model spec string (for display and logging)."""
    return model_specs()[0]


def model_options() -> list[dict[str, str]]:
    """The ``models=`` list deepagents-acp turns into the ``model`` config option.

    Always at least one entry, so a client can rely on the select being advertised.
    """
    return [{"value": spec, "name": spec} for spec in model_specs()]


def resolve_model(spec: str | None = None) -> str | BaseChatModel:
    """Return what ``create_deep_agent(model=...)`` should receive for ``spec`` (default when None).

    A provider string lets deepagents apply its provider profile; a constructed
    ``ChatOpenAI`` instance bypasses that and targets a custom OpenAI-compatible endpoint.
    """
    spec = spec or model_spec()
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
