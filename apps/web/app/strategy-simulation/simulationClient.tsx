"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/clientApi";
import { SimulationResult } from "@/lib/types";

export function SimulationClient({ strategyId }: { strategyId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!strategyId) {
      setError("Create a recommendation in the AI Workspace first.");
      return;
    }
    void doSimulate();
  }, [strategyId]);

  async function doSimulate() {
    setLoading(true);
    setError("");
    try {
      const data = await fetchJson<{ simulationResult: SimulationResult; message?: string }>(
        "/api/strategy/simulate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategyId }),
        },
        "The strategy comparison failed."
      );
      setSim(data.simulationResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="notice">Comparing strategies…</div>;
  if (error) return <div className="notice error">{error}</div>;
  if (!sim) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Strategy comparison</h1>
        </div>
        <button className="ghost" onClick={() => router.push("/ai-strategy")}>
          Return to AI Workspace
        </button>
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="card-title">Current plan vs. AdPilot recommendation</h2>
          </div>
          <span className="badge badge-blue">Strategy #{strategyId}</span>
        </div>

        <div className="comparison-grid">
          <div className="comparison-column">
            <h3>Current plan</h3>
            <div className="split-metrics">
            <div className="metric">
              <div className="metric-label">Cost index</div>
              <div className="metric-value">{sim.baseline.cost.toFixed(2)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Conversions</div>
              <div className="metric-value">{sim.baseline.conversions}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Attributed conversions</div>
              <div className="metric-value">{sim.baseline.attributedConversions}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Utility score</div>
              <div className="metric-value">{sim.baseline.score.toFixed(2)}</div>
            </div>
            </div>
          </div>

          <div className="comparison-column">
            <h3>AdPilot recommendation</h3>
            <div className="split-metrics">
            <div className="metric">
              <div className="metric-label">Cost index</div>
              <div className="metric-value">{sim.strategy.cost.toFixed(2)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Conversions</div>
              <div className="metric-value">{sim.strategy.conversions}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Attributed conversions</div>
              <div className="metric-value">{sim.strategy.attributedConversions}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Utility score</div>
              <div className="metric-value">{sim.strategy.score.toFixed(2)}</div>
            </div>
            </div>
          </div>
        </div>

        <div className="notice" style={{ marginTop: 14 }}>
          Affected campaigns: {sim.changedCampaigns.join(", ") || "None"}
        </div>
      </section>
    </div>
  );
}
