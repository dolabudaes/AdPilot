"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

export function Fade({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay }}>
      {children}
    </motion.div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <section className="ap-empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? (
        <p style={{ marginTop: 12 }}>
          <a className="ap-btn primary" href={action.href}>
            {action.label}
          </a>
        </p>
      ) : null}
    </section>
  );
}

export function emptyCopy(reason: string | null) {
  if (reason === "no_source") return { title: "No data source connected", body: "Connect a readable advertising dataset before generating an investigation.", href: "/data-sources", label: "Open data sources" };
  if (reason === "not_synced") return { title: "The data source is not ready", body: "AdPilot needs campaign_daily.csv and campaign_summary.json. An upload record does not replace these processed files.", href: "/data-sources", label: "Review data source" };
  if (reason === "unknown_account") return { title: "No analysis data for this account", body: "Only processed logs marked as demo data are available. Unconnected ad platforms are never shown as connected.", href: "/overview", label: "Return to demo account" };
  if (reason === "incomplete") return { title: "Incomplete dataset", body: "Campaign or daily details are missing, so the investigation has stopped.", href: "/data-sources", label: "Check data coverage" };
  return null;
}
