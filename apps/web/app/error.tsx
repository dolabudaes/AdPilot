"use client";

export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <section className="ap-empty">
      <h2>This page did not finish loading</h2>
      <p>{error.message || "Try again. No data was changed."}</p>
      <button className="ap-btn primary" type="button" onClick={reset}>Try again</button>
    </section>
  );
}
