import { getDataHealth } from "@/lib/copilot/health";
import { ImportPanel } from "./import-panel";

export const dynamic = "force-dynamic";

const AVAILABLE = ["Impressions", "Clicks", "Conversion-linked clicks", "Attributed conversion links", "Cost index", "CTR", "Post-click conversion-link rate"];

export default function DataSourcesPage() {
  const health = getDataHealth();
  return (
    <div className="ap-page ap-data-trust">
      <header className="ap-page-head">
        <h1>Data management</h1>
        <p className="ap-muted">Anonymized Criteo advertising logs. Not live delivery data.</p>
      </header>

      <div className="ap-data-hero">
        <div className="ap-stat-card">
          <span>Data source</span>
          <strong>{health.sourceConnected ? "Demo logs" : "Not registered"}</strong>
        </div>
        <div className="ap-stat-card">
          <span>Campaign coverage</span>
          <strong className="ap-num">{health.campaignCount}</strong>
          <small className="ap-muted">{health.dayCount} days{health.dayMin != null ? ` · D${health.dayMin}–D${health.dayMax}` : ""}</small>
        </div>
        <div className="ap-stat-card">
          <span>Processed</span>
          <strong>{health.generatedAt ? new Date(health.generatedAt).toLocaleDateString("en-US") : "—"}</strong>
        </div>
        <div className="ap-stat-card">
          <span>Freshness</span>
          <strong>{health.stale ? "Historical snapshot" : health.filesReady ? "Within window" : "No data"}</strong>
          {health.ageDays != null ? <small className="ap-muted">{health.ageDays} days old</small> : null}
        </div>
        <div className="ap-stat-card">
          <span>Runtime files</span>
          <strong>{health.filesReady ? "Readable" : "Unavailable"}</strong>
        </div>
        <div className="ap-stat-card">
          <span>Service</span>
          <strong>{health.serviceOnline ? "Online" : "Unavailable"}</strong>
        </div>
      </div>

      <div className="ap-data-columns">
        <section className="ap-panel">
          <h2 className="ap-section-title">Data coverage</h2>
          <p>{AVAILABLE.join(", ")}</p>
          <p className="ap-muted">Campaigns meeting the recent 7-day diagnostic click threshold: {health.diagnosableShare == null ? "—" : `${Math.round(health.diagnosableShare * 100)}%`}.</p>
        </section>
        <section className="ap-panel">
          <h2 className="ap-section-title">Currently unavailable</h2>
          {health.unavailable.map((field) => <p key={field.field} className="ap-muted">{englishValue(field.field, "Unsupported field")}: {englishValue(field.reason, "Not included in the imported dataset.")}</p>)}
          {health.affected.map((item) => <p key={item} className="ap-muted">{englishValue(item, "Some analyses are unavailable because the required fields are missing.")}</p>)}
        </section>
      </div>

      <section className="ap-panel">
        <h2 className="ap-section-title">Import CSV / TSV</h2>
        <p className="ap-muted">Latest upload: {health.lastUploadName || "None"}{health.lastUploadAt ? ` · ${new Date(health.lastUploadAt).toLocaleString("en-US")}` : ""}</p>
        <ImportPanel canPreview canRecord />
      </section>

      <details className="ap-fold ap-panel">
        <summary>Advanced details · field mapping and run history</summary>
        <div style={{ marginTop: 12 }}>
          {health.fieldMapping.map((field) => <p key={field.target} className="ap-muted">{field.target} ← {field.source}</p>)}
          {health.runs.length ? health.runs.map((run) => (
            <p key={run.id} className="ap-muted">{new Date(run.startedAt).toLocaleString("en-US")} · {run.type} · {run.status} · {englishValue(run.summary, "Data check completed")}{run.error ? ` · ${englishValue(run.error, "Run failed")}` : ""}</p>
          )) : <p className="ap-muted">No sync or validation runs yet.</p>}
        </div>
      </details>
    </div>
  );
}

function englishValue(value: string, fallback: string) {
  return /[\u3400-\u9fff]/.test(value) ? fallback : value;
}
