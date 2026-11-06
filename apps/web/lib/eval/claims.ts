export type ClaimCategory = {
  id: string;
  label: string;
  pattern: RegExp;
};

export const PROHIBITED_CLAIMS: ClaimCategory[] = [
  {
    id: "budget_change",
    label: "actual budget change",
    pattern: /(预算|budget).{0,24}(增加|减少|上调|下调|提高|降低|changed|increased|decreased|cut|raised)/i,
  },
  {
    id: "roas_gain",
    label: "ROAS improvement",
    pattern: /ROAS[^。\n]{0,24}(提升|提高|上升|改善|improved|increased|\+)/i,
  },
  {
    id: "creative_fatigue",
    label: "creative fatigue",
    pattern: /素材疲劳|creative fatigue|素材衰减/i,
  },
  {
    id: "age_shift",
    label: "audience age change",
    pattern: /(受众)?年龄[^。\n]{0,16}(变化|上升|下降|变大|变小|changed|older|younger)|audience age[^.\n]{0,24}(change|changed|shift|older|younger)/i,
  },
  {
    id: "verified_optimization",
    label: "verified optimization outcome",
    pattern: /优化效果已经|已验证的优化|优化已经生效|verified (lift|optimization)|优化已带来/i,
  },
];

const DENIAL = /没有|不能|无法|并非|不是|不可|无此|不代表|不能写成|不能确定|尚未|并未|do not|does not|cannot|can't|unavailable|not available|no budget|no roas/i;

export type ClaimHit = { id: string; label: string; sentence: string };

export function scanUnsupportedClaims(reportText: string): ClaimHit[] {
  const sentences = reportText
    .split(/[。！？\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const hits: ClaimHit[] = [];
  for (const category of PROHIBITED_CLAIMS) {
    const sentence = sentences.find((item) => category.pattern.test(item) && !DENIAL.test(item));
    if (sentence) hits.push({ id: category.id, label: category.label, sentence: sentence.slice(0, 180) });
  }
  return hits;
}
