CONFIRMED = {"confirmed", "approved", "exported", "externally_marked"}
DISMISSED = {"dismissed", "rejected"}


def normalize_decision_status(status: str | None) -> str:
    raw = (status or "").lower()
    if raw in CONFIRMED:
        return "confirmed"
    if raw in DISMISSED:
        return "dismissed"
    return "draft"


def is_confirmed_status(status: str | None) -> bool:
    return normalize_decision_status(status) == "confirmed"
