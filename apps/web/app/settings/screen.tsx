"use client";

import { FormEvent, useState, type ReactNode } from "react";
import type { SettingsRecord } from "@/lib/dataStore";

export function SettingsScreen({ settings }: { settings: SettingsRecord }) {
  const [form, setForm] = useState(settings);
  const [message, setMessage] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const data = (await response.json()) as { message?: string };
    setMessage(response.ok ? "Settings saved and applied." : data.message || "Settings could not be saved.");
  }

  return <main className="ap-settings-page ap-settings-v2">
    <header className="ap-settings-header">
      <div><h1>Settings</h1></div>
    </header>

    <form onSubmit={onSubmit}>
      <SettingsSection title="Imported snapshot">
        <p>Anonymized Criteo advertising logs, not a live ad account. Conversion-link rate is the share of clicks with a future 30-day conversion label in the selected window—not live platform CVR or ROI.</p>
      </SettingsSection>
      <SettingsSection title="Analysis engine">
        <div className="ap-settings-edit-grid">
          <label><span>Response engine</span><select value={form.llm_provider} onChange={(event) => setForm({ ...form, llm_provider: event.target.value })}><option value="mock">Built-in deterministic</option><option value="openai-compatible">OpenAI-compatible endpoint</option></select></label>
          {form.llm_provider === "openai-compatible" ? <><label><span>Model</span><input value={form.llm_model} onChange={(event) => setForm({ ...form, llm_model: event.target.value })} /></label><label><span>Endpoint</span><input value={form.llm_base_url} onChange={(event) => setForm({ ...form, llm_base_url: event.target.value })} /></label><label><span>API key</span><input type="password" autoComplete="off" value={form.llm_api_key} onChange={(event) => setForm({ ...form, llm_api_key: event.target.value })} /></label></> : null}
        </div>
      </SettingsSection>

      <SettingsSection title="Analysis thresholds">
        <div className="ap-settings-edit-grid"><label><span>Minimum clicks</span><input type="number" min={20} value={form.analysis_min_clicks} onChange={(event) => setForm({ ...form, analysis_min_clicks: Number(event.target.value) })} /></label><label><span>Stale after</span><input type="number" min={1} value={form.stale_after_days} onChange={(event) => setForm({ ...form, stale_after_days: Number(event.target.value) })} /></label></div>
      </SettingsSection>

      <footer className="ap-settings-save">{message ? <p>{message}</p> : null}<button className="ap-btn primary" type="submit">Save settings</button></footer>
    </form>
  </main>;
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ap-settings-section"><div className="ap-settings-section-title"><div><h2>{title}</h2></div></div>{children}</section>;
}
