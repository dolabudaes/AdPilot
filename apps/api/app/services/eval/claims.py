import re

PROHIBITED = [
    (r"(预算|budget).{0,24}(增加|减少|上调|下调|提高|降低|changed|increased|decreased|cut|raised)", "actual budget change"),
    (r"ROAS[^。\n]{0,24}(提升|提高|上升|改善|improved|increased|\+)", "ROAS improvement"),
    (r"素材疲劳|creative fatigue|素材衰减", "creative fatigue"),
    (r"(受众)?年龄[^。\n]{0,16}(变化|上升|下降|变大|变小|changed|older|younger)|audience age[^.\n]{0,24}(change|changed|shift|older|younger)", "audience age change"),
    (r"优化效果已经|已验证的优化|优化已经生效|verified (lift|optimization)|优化已带来", "verified optimization outcome"),
]
DENIAL = re.compile(r"没有|不能|无法|并非|不是|不可|无此|不代表|不能写成|不能确定|尚未|并未|do not|does not|cannot|can't|unavailable|not available|no budget|no roas", re.I)


def scan_unsupported_claims(report_text: str) -> list[dict]:
    sentences = [s.strip() for s in re.split(r"[。！？\n]", report_text) if s.strip()]
    hits = []
    for pattern, label in PROHIBITED:
        rx = re.compile(pattern, re.I)
        for sentence in sentences:
            if rx.search(sentence) and not DENIAL.search(sentence):
                hits.append({"id": label, "label": label, "sentence": sentence[:180]})
                break
    return hits
