"""Ask the VLM module a question about pictures."""

from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from app.http_errors import describe_http_error
from app.modules import ModuleRegistry

MODULE_NAME = "vlm"


class VlmError(Exception):
    """The VLM module is not available or could not answer."""


@dataclass(frozen=True)
class VlmAnswer:
    text: str
    latency_ms: float | None
    new_tokens: int | None


@dataclass(frozen=True)
class AskOptions:
    system: str | None = None
    max_new_tokens: int = 256
    temperature: float = 0.0  # 0 = greedy (the same answer every time)

    def decoding_params(self) -> dict:
        params: dict = {"max_new_tokens": self.max_new_tokens}
        if self.temperature > 0:
            params.update(do_sample=True, temperature=self.temperature)
        return params


class VlmClient:
    def __init__(self, registry: ModuleRegistry, http_client: httpx.AsyncClient, timeout: float, recorder=None) -> None:
        self.registry = registry
        self.http_client = http_client
        self.timeout = timeout
        self.recorder = recorder  # UsageRecorder: every question goes to the history

    async def ask(
        self, prompt: str, pictures: list[bytes], options: AskOptions | None = None, source: str = "VLM tools"
    ) -> VlmAnswer:
        options = options or AskOptions()
        if problem := await self.registry.ensure_running(MODULE_NAME):
            raise VlmError(f"VLM module: {problem}")
        url = self.registry.get(MODULE_NAME).url
        data = {
            "prompt": prompt,
            "params": json.dumps(options.decoding_params()),
            "sequence": str(len(pictures) > 1).lower(),
        }
        if options.system:
            data["system"] = options.system
        files = [("images", (f"picture-{index + 1}.jpg", jpeg, "image/jpeg")) for index, jpeg in enumerate(pictures)]
        try:
            arguments = {"data": data, "files": files or None, "timeout": self.timeout}
            if self.recorder:
                details = {**data, "pictures": len(pictures)}
                first = pictures[0] if pictures else None
                response = await self.recorder.post(
                    self.http_client,
                    MODULE_NAME,
                    f"{url}/v1/generate",
                    source=source,
                    request=details,
                    picture=first,
                    **arguments,
                )
            else:
                response = await self.http_client.post(f"{url}/v1/generate", **arguments)
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise VlmError(f"VLM module: {describe_http_error(error)}") from error
        answer = response.json()
        return VlmAnswer(
            text=answer.get("text", "").strip(),
            latency_ms=answer.get("latency_ms"),
            new_tokens=answer.get("new_tokens"),
        )
