"""The chat models an agent can think with.

* ``vlm``: the local VLM module, wrapped as a LangChain chat model (no key, no internet;
  it can also see the frames). Small models do not call tools natively, so the agent
  uses the ReAct text protocol with them.
* ``anthropic:<model>`` / ``openai:<model>``: cloud models with native tool calling,
  when listed in ``MANAGER_AGENT_MODELS``, their package installed
  (``pip install .[providers]``) and their API key set (``ANTHROPIC_API_KEY``,
  ``OPENAI_API_KEY``).
"""

from __future__ import annotations

import importlib
import os
from dataclasses import asdict, dataclass
from importlib.util import find_spec

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict

from app.vlm.client import AskOptions, VlmClient

LOCAL_MODEL = "vlm"
PROVIDERS = {
    # provider: (package, class, API key variable)
    "anthropic": ("langchain_anthropic", "ChatAnthropic", "ANTHROPIC_API_KEY"),
    "openai": ("langchain_openai", "ChatOpenAI", "OPENAI_API_KEY"),
}


class ModelUnavailableError(ValueError):
    """The chosen chat model is not configured, installed or keyed."""


class VlmChatModel(BaseChatModel):
    """LangChain chat model backed by the VLM module (``/v1/generate``).

    The conversation is written out as text (system prompt apart); ``pictures`` are
    shown with every call when ``show_pictures`` is on.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    client: VlmClient
    pictures: list[bytes] = []
    show_pictures: bool = False
    max_new_tokens: int = 384

    @property
    def _llm_type(self) -> str:
        return "multivision-vlm-module"

    @staticmethod
    def _as_text(messages: list[BaseMessage]) -> tuple[str | None, str]:
        system = "\n\n".join(str(message.content) for message in messages if isinstance(message, SystemMessage))
        lines = []
        for message in messages:
            if isinstance(message, SystemMessage):
                continue
            prefix = {"human": "", "ai": "Assistant: ", "tool": "Observation: "}.get(message.type, "")
            lines.append(f"{prefix}{message.content}")
        return system or None, "\n\n".join(lines)

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs,
    ) -> ChatResult:
        system, prompt = self._as_text(messages)
        pictures = self.pictures if self.show_pictures else []
        answer = await self.client.ask(
            prompt, pictures, AskOptions(system=system, max_new_tokens=self.max_new_tokens), source="Agent"
        )
        text = answer.text
        for marker in stop or []:  # the module has no stop sequences: cut afterwards
            text = text.split(marker)[0]
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text.strip()))])

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs,
    ) -> ChatResult:
        raise NotImplementedError("the VLM chat model is asynchronous: use ainvoke")


@dataclass(frozen=True)
class ModelChoice:
    id: str
    label: str
    available: bool
    native_tools: bool  # calls tools itself (else: ReAct text protocol)
    reason: str = ""

    def to_api(self) -> dict:
        return asdict(self)


def configured_models(setting: str) -> list[str]:
    return [LOCAL_MODEL] + [
        entry.strip() for entry in setting.split(",") if entry.strip() and entry.strip() != LOCAL_MODEL
    ]


def describe_model(model_id: str) -> ModelChoice:
    if model_id == LOCAL_MODEL:
        return ModelChoice(LOCAL_MODEL, "Local VLM module (ReAct, sees the frames)", True, native_tools=False)
    provider, _, name = model_id.partition(":")
    if provider not in PROVIDERS or not name:
        return ModelChoice(model_id, model_id, False, True, "unknown provider: use anthropic:<model> or openai:<model>")
    package, _, key = PROVIDERS[provider]
    if find_spec(package) is None:
        return ModelChoice(
            model_id, model_id, False, True, f"install {package.replace('_', '-')} (pip install .[providers])"
        )
    if not os.environ.get(key):
        return ModelChoice(model_id, model_id, False, True, f"set {key}")
    return ModelChoice(model_id, f"{name} ({provider}, native tool calling)", True, native_tools=True)


def create_chat_model(
    model_id: str, vlm: VlmClient, pictures: list[bytes], show_pictures: bool = False
) -> BaseChatModel:
    choice = describe_model(model_id)
    if not choice.available:
        raise ModelUnavailableError(f"model {model_id!r} is not available: {choice.reason}")
    if model_id == LOCAL_MODEL:
        return VlmChatModel(client=vlm, pictures=pictures, show_pictures=show_pictures)
    provider, _, name = model_id.partition(":")
    package, class_name, _ = PROVIDERS[provider]
    model_class = getattr(importlib.import_module(package), class_name)
    return model_class(model=name, temperature=0)
