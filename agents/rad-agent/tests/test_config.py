"""Model selection: RAD_MODELS / RAD_MODEL precedence and the ACP model list."""

from __future__ import annotations

import pytest

from rad_agent.config import DEFAULT_MODEL, model_options, model_spec, model_specs, resolve_model


def test_default_when_nothing_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAD_MODELS", raising=False)
    monkeypatch.delenv("RAD_MODEL", raising=False)
    assert model_specs() == [DEFAULT_MODEL]
    assert model_spec() == DEFAULT_MODEL
    assert model_options() == [{"value": DEFAULT_MODEL, "name": DEFAULT_MODEL}]


def test_rad_model_is_the_single_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAD_MODELS", raising=False)
    monkeypatch.setenv("RAD_MODEL", "anthropic:claude-sonnet-5")
    assert model_specs() == ["anthropic:claude-sonnet-5"]


def test_rad_models_wins_first_is_default_and_blanks_are_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RAD_MODELS", " openai:gpt-5.6-terra , ,anthropic:claude-sonnet-5,")
    monkeypatch.setenv("RAD_MODEL", "ignored:model")
    assert model_specs() == ["openai:gpt-5.6-terra", "anthropic:claude-sonnet-5"]
    assert model_spec() == "openai:gpt-5.6-terra"
    assert [o["value"] for o in model_options()] == [
        "openai:gpt-5.6-terra",
        "anthropic:claude-sonnet-5",
    ]


def test_resolve_model_returns_the_spec_without_a_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAD_MODEL_BASE_URL", raising=False)
    monkeypatch.setenv("RAD_MODELS", "openai:a,openai:b")
    assert resolve_model() == "openai:a"
    assert resolve_model("openai:b") == "openai:b"


def test_resolve_model_builds_chat_openai_against_a_base_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("RAD_MODEL_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    model = resolve_model("openai:gpt-oss:20b")
    assert type(model).__name__ == "ChatOpenAI"
    assert model.model_name == "gpt-oss:20b"  # type: ignore[union-attr]
