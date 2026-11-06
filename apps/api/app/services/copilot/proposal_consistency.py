from app.services.copilot.labels import ACTION_LABEL


def proposal_consistency_issue(action_type: str, reason: str) -> str | None:
    rationale = reason.strip().lower()
    if not rationale:
        return None
    for candidate, label in ACTION_LABEL.items():
        if candidate != action_type and label.lower() in rationale:
            return f'The rationale still describes “{label}”. Update it to match “{ACTION_LABEL[action_type]}” before submitting.'
    return None
