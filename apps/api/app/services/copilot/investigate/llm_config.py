import os
import time

from app.services.data_store import get_settings

INVESTIGATION_WALL_CLOCK_MS = int(os.environ.get("ADPILOT_INVESTIGATION_TIMEOUT_MS", 90000))
MAX_LLM_CALLS_PER_INVESTIGATION = int(os.environ.get("ADPILOT_MAX_LLM_CALLS", 8))


def is_real_llm_configured() -> bool:
    settings = get_settings()
    return settings.get("llm_provider") == "openai-compatible" and bool((settings.get("llm_api_key") or "").strip())


class InvestigationBudget:
    def __init__(self):
        self.max_wall_clock_ms = INVESTIGATION_WALL_CLOCK_MS
        self.max_llm_calls = MAX_LLM_CALLS_PER_INVESTIGATION
        self.started_at = time.perf_counter()
        self.llm_calls = 0

    def elapsed_ms(self) -> int:
        return int((time.perf_counter() - self.started_at) * 1000)

    def assert_within_wall_clock(self) -> None:
        if self.elapsed_ms() > self.max_wall_clock_ms:
            raise RuntimeError("investigation_timeout")

    def assert_can_call_llm(self) -> None:
        self.assert_within_wall_clock()
        if self.llm_calls >= self.max_llm_calls:
            raise RuntimeError("investigation_llm_budget")

    def record_llm_call(self) -> None:
        self.llm_calls += 1


def create_investigation_budget() -> InvestigationBudget:
    return InvestigationBudget()
