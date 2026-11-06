import json
import os
import re
from typing import Any, TypeVar

from app.services.data_store import get_settings

T = TypeVar("T")


def extract_json(text: str) -> Any:
    trimmed = text.strip()
    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        start = trimmed.find("{")
        end = trimmed.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise ValueError("Could not extract JSON from the response")
        return json.loads(trimmed[start : end + 1])


class MockLLMProvider:
    async def generate_structured(self, system_prompt: str, user_prompt: str) -> Any:
        text = user_prompt.lower()
        avoids = any(x in user_prompt for x in ("不希望为了点击", "不想为了点击", "不要为了点击", "浪费投放"))
        wants_clicks = not avoids and any(x in user_prompt or x in text for x in ("点击", "click", "流量", "traffic", "曝光"))
        accepts_decline = any(x in user_prompt for x in ("可以接受转化", "接受转化效率", "转化效率略微下降"))
        wants_conversion = not accepts_decline and any(x in user_prompt for x in ("转化", "conversion", "有效", "cvr"))
        wants_cost = not accepts_decline and any(x in user_prompt for x in ("成本", "浪费", "低效", "效率"))
        wants_risk = any(x in user_prompt for x in ("风险", "恶化", "最近", "明显下降"))
        primary = (
            "effective_conversion"
            if wants_conversion
            else "risk_control"
            if wants_risk
            else "traffic_growth"
            if wants_clicks
            else "cost_efficiency"
            if wants_cost and not wants_conversion
            else "other"
        )
        payload = {
            "primaryGoal": primary,
            "secondaryGoals": [
                x
                for x in [
                    wants_conversion and "Improve effective conversions",
                    wants_clicks and "Grow clicks or traffic",
                    wants_cost and "Reduce inefficient clicks and waste",
                    wants_risk and "Prioritize recently declining campaigns",
                ]
                if x
            ],
            "preferences": {
                "prioritizeConversion": wants_conversion,
                "prioritizeClicks": wants_clicks,
                "prioritizeAttributedConversion": wants_conversion or ("归因" in user_prompt),
                "prioritizeCostEfficiency": wants_cost or wants_conversion,
                "prioritizeRecentDecline": wants_risk,
                "prioritizeRiskControl": wants_risk or any(x in user_prompt for x in ("不能", "不希望")),
            },
            "constraints": [
                x
                for x in [
                    ("不希望" in user_prompt or "不能" in user_prompt) and "Avoid strong actions unrelated to the goal",
                    wants_cost and "Focus on inefficient clicks and waste",
                ]
                if x
            ],
            "rawInput": user_prompt,
        }
        return extract_json(json.dumps(payload))


class OpenAICompatibleProvider:
    def __init__(self, base_url: str, api_key: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    async def generate_structured(self, system_prompt: str, user_prompt: str) -> Any:
        import httpx

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "temperature": 0.2,
                    "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                },
            )
        if response.status_code >= 400:
            raise RuntimeError(f"LLM API call failed: {response.status_code}")
        data = response.json()
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or "{}"
        return extract_json(content)


def get_llm_provider_from_env():
    settings = get_settings()
    provider = os.environ.get("LLM_PROVIDER") or settings.get("llm_provider") or "mock"
    model = os.environ.get("LLM_MODEL") or settings.get("llm_model") or "gpt-4o-mini"
    base_url = os.environ.get("LLM_BASE_URL") or settings.get("llm_base_url") or "https://api.openai.com/v1"
    api_key = os.environ.get("LLM_API_KEY") or settings.get("llm_api_key") or ""
    if provider == "openai-compatible":
        return OpenAICompatibleProvider(base_url, api_key, model)
    return MockLLMProvider()
