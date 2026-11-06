"use client";

import type { MessageRecord } from "@/lib/copilot/conversations";
import { TrendChart } from "./chart";

export function InvestigationFinding({
  message,
  question,
}: {
  message: MessageRecord;
  question: string;
}) {
  const presentation = message.investigation?.presentation;
  if (!presentation) {
    return message.content ? <p className="ap-finding-plain">{message.content}</p> : null;
  }

  const mode = answerMode(question, Boolean(message.series?.length));
  const comparisons = mode === "comparison" ? comparisonRows(message.evidence) : [];
  const accountFindings = mode === "account" ? (message.investigation?.found || []).filter((item) => /^Campaign\s+/i.test(item)) : [];
  const showChart = Boolean(message.series?.length) && (mode === "trend" || /daily|trend|sustained|concentrated|days|dates/i.test(question));
  const showStructure = presentation.structure === "full" && mode !== "direct";
  const metrics = presentation.metrics || [];
  const limitations = presentation.limitations || [];

  return (
    <article className={`ap-investigation-finding ap-investigation-finding--flow is-${mode}`} data-reveal>
      <section className="ap-answer-section ap-answer-conclusion">
        <p className="ap-finding-lead">{englishLine(message.content || presentation.finding, "I could not produce a complete answer from the available campaign data.")}</p>
      </section>

      {showStructure && metrics.length ? (
        <section className="ap-answer-section">
          <span>Supporting evidence</span>
          <div className="ap-finding-metrics">
            {metrics.map((item) => (
              <article key={`${item.label}-${item.value}`}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
                {item.detail ? <em>{item.detail}</em> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {showStructure && presentation.interpretation ? (
        <section className="ap-answer-section">
          <span>Interpretation</span>
          <p>{presentation.interpretation}</p>
        </section>
      ) : null}

      {showStructure && limitations.length ? (
        <section className="ap-answer-section">
          <span>Limitations</span>
          <ul>{limitations.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      ) : null}

      {showStructure && presentation.nextStep ? (
        <section className="ap-answer-section">
          <span>Recommended next step</span>
          <p>{presentation.nextStep}</p>
        </section>
      ) : null}

      {accountFindings.length ? (
        <section className="ap-answer-section ap-account-evidence">
          <ul>{accountFindings.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      ) : comparisons.length >= 2 ? (
        <section className="ap-answer-section ap-comparison-evidence">
          <div>{comparisons.map((item) => <article key={item.campaign}><strong>{item.campaign}</strong><b>{item.value}</b><small>{item.relative}</small></article>)}</div>
        </section>
      ) : null}

      {showChart ? (
        <section className="ap-answer-section ap-finding-chart">
          <span>Daily trend</span>
          <TrendChart
            points={message.series || []}
            anomalies={[]}
            metric="cvr"
            currentStart={presentation.currentStart}
            currentEnd={presentation.currentEnd}
            compareStart={presentation.compareStart}
            compareEnd={presentation.compareEnd}
            windowLabel={presentation.windowLabel}
            compareLabel={presentation.compareLabel}
          />
        </section>
      ) : null}

    </article>
  );
}

function answerMode(question: string, hasSeries: boolean) {
  const value = question.toLowerCase();
  if (/which campaigns|campaigns .*attention|account[- ]wide|portfolio[- ]wide/.test(value)) return "account";
  if (/same pattern|compar|versus|\bvs\b/.test(value)) return "comparison";
  if (hasSeries && /daily|trend|day|sustained|concentrated/.test(value)) return "trend";
  if (/why|cause|explain|what changed|change|performance|cvr|ctr|priority|flagged/.test(value)) return "diagnosis";
  if (/should|recommend|next|optimiz/.test(value)) return "recommendation";
  return "direct";
}

function comparisonRows(evidence: MessageRecord["evidence"]) {
  const rows = new Map<string, { campaign: string; value: string; relative: string }>();
  for (const item of evidence) {
    if (!/cvr/i.test(item.metric || item.label)) continue;
    const campaign = item.id?.match(/^metric:([^:]+):/)?.[1];
    if (!campaign || rows.has(campaign)) continue;
    rows.set(campaign, { campaign, value: item.value, relative: item.relative || "Comparison unavailable" });
  }
  return [...rows.values()];
}

function hasChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

function englishLine(value: string, fallback: string) {
  return value && !hasChinese(value) ? value : fallback;
}
