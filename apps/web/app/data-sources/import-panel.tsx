"use client";

import { useState } from "react";
import { fetchJson } from "@/lib/clientApi";

type Preview = {
  preview: { missing: string[]; recognized: string[]; warnings: string[]; ready: boolean };
  note: string;
  rowCount: number;
  fileName: string;
};

export function ImportPanel({ canPreview, canRecord }: { canPreview: boolean; canRecord: boolean }) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function onFile(file: File) {
    setError("");
    setMessage("");
    setPreview(null);
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const delimiter = file.name.toLowerCase().endsWith(".tsv") || (lines[0] || "").includes("\t") ? "\t" : ",";
    const header = (lines[0] || "").split(delimiter).map((item) => item.trim()).filter(Boolean);
    setFileName(file.name);
    setHeaders(header);
    setRowCount(Math.max(lines.length - 1, 0));
    if (!canPreview) {
      setError("Your current role cannot preview imports.");
      return;
    }
    try {
      const data = await fetchJson<Preview>("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true, headers: header, fileName: file.name, rowCount: Math.max(lines.length - 1, 0) }),
      }, "The import preview failed.");
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The import preview failed.");
    }
  }

  async function record() {
    setError("");
    try {
      await fetchJson("/api/data-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "connected", metadata: { lastFileName: fileName, lastRowCount: rowCount, previewReady: preview?.preview.ready || false } }),
      }, "The upload record could not be saved.");
      setMessage("The upload was recorded. The analysis dataset was not replaced.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload record could not be saved.");
    }
  }

  return (
    <div className="ap-upload-zone">
      <p className="ap-muted">Choose a CSV or TSV file to preview fields.</p>
      <input aria-label="Choose report file" type="file" accept=".csv,.tsv,.txt" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); }} />
      {preview ? (
        <div>
          <p>{preview.fileName} · {preview.rowCount} rows · Recognized: {preview.preview.recognized.join(", ") || "None"}</p>
          {preview.preview.missing.length ? <p>Missing: {preview.preview.missing.join(", ")}</p> : <p>All required fields are present.</p>}
          {preview.preview.warnings.map((item) => <p key={item}>{item}</p>)}
          <p>{preview.note}</p>
          {canRecord ? <button className="ap-btn" type="button" onClick={() => void record()}>Record upload</button> : null}
        </div>
      ) : null}
      {message ? <p>{message}</p> : null}
      {error ? <p>{error}</p> : null}
    </div>
  );
}
