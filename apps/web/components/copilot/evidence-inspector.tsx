"use client";

import { useEffect, useState } from "react";
import { TrendChart } from "@/components/copilot/chart";
import { formatCount, formatRate } from "@/lib/copilot/labels";
import { fetchJson } from "@/lib/clientApi";
import type { FindingView, ProductModel, TrendPoint } from "@/lib/copilot/types";
import { formatWindowRange } from "@/lib/copilot/windows";

export function EvidenceInspector({
  finding,
  model,
  focusLabel,
  onClose,
}: {
  finding: FindingView;
  model: ProductModel;
  focusLabel?: string | null;
  onClose: () => void;
}) {
  const [series, setSeries] = useState<TrendPoint[]>([]);
  const hasCompare = Boolean(finding.compareLabel);

  useEffect(() => {
    void fetchJson<{ detail: { series: TrendPoint[] } }>(`/api/campaigns/${encodeURIComponent(finding.campaignId)}?window=${encodeURIComponent(finding.windowId)}`)
      .then((result) => setSeries(result.detail.series))
      .catch(() => setSeries([]));
  }, [finding.campaignId, finding.windowId]);

  useEffect(() => {
    if (!focusLabel) return;
    const el = document.getElementById("evidence-focus");
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusLabel, series.length]);

  return (
    <aside className="ap-evidence-inspector is-open" role="dialog" aria-label="Evidence inspector">
      <header>
        <div>
          <h2>{finding.campaignName}</h2>
          <p className="ap-muted">{formatWindowRange(finding) || finding.windowLabel}</p>
        </div>
        <button type="button" className="ap-btn" onClick={onClose}>Close</button>
      </header>
      <section>
        <h3>Overview</h3>
        <p>Conversion-link rate <strong>{formatRate(finding.raw.cvr)}</strong> · Conversion-linked clicks <strong>{formatCount(finding.raw.conversions)}</strong> · Clicks <strong>{formatCount(finding.raw.clicks)}</strong></p>
        {!hasCompare ? <p className="ap-muted">No comparison period in this window. Do not infer period-over-period change from these values alone.</p> : null}
      </section>
      <details open>
        <summary>Metrics & definitions</summary>
        <ul className="ap-ws-evidence-list">
          {finding.evidence.map((item) => {
            const name = label(item.label);
            const focused = focusLabel && (focusLabel === item.label || focusLabel === name);
            return (
              <li key={item.label} className={focused ? "is-focused" : undefined} id={focused ? "evidence-focus" : undefined}>
                <span>{name}</span>
                <strong>{item.value}</strong>
                <small>{item.baseline ? `Baseline ${item.baseline}` : "No baseline"} · {item.delta || "—"}</small>
              </li>
            );
          })}
        </ul>
      </details>
      <details>
        <summary>Daily trend</summary>
        {series.length ? <TrendChart points={series} anomalies={[]} metric="cvr" currentStart={model.window?.start} currentEnd={model.window?.end} compareStart={model.window?.compareStart} compareEnd={model.window?.compareEnd} windowLabel={finding.windowLabel} compareLabel={finding.compareLabel} /> : <p className="ap-muted">Daily series unavailable.</p>}
      </details>
    </aside>
  );
}

function label(value: string) {
  const map: Record<string, string> = {
    "曝光": "Impressions", "点击": "Clicks", "点击率": "CTR", "转化": "Conversion-linked clicks", "转化关联点击": "Conversion-linked clicks",
    Conversions: "Conversion-linked clicks",
    "点击后转化率": "Post-click conversion-link rate", "点击后转化关联率": "Post-click conversion-link rate", "Post-click CVR": "Post-click conversion-link rate",
    "归因转化": "Attributed conversion links", "Attributed conversions": "Attributed conversion links", "成本指数": "Cost index", "成本指数总值": "Cost index total",
  };
  return map[value] || value;
}
