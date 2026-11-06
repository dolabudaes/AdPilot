"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/copilot/icons";
import { ROLE_LABEL } from "@/lib/copilot/labels";
import type { ShellModel } from "@/lib/copilot/shell-data";

const NAV = [
  { href: "/overview", label: "Project Overview", icon: "overview", match: ["/overview"] },
  { href: "/campaigns", label: "Campaigns", icon: "campaigns", match: ["/campaigns"] },
  { href: "/workspace", label: "AI Workspace", icon: "campaigns", match: ["/workspace"] },
  { href: "/decisions", label: "Decisions", icon: "decisions", match: ["/decisions"] },
];

const SECONDARY = [{ href: "/settings", label: "Settings", icon: "settings" }];

export function AppShell({ shell, children }: { shell: ShellModel; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const account = searchParams.get("account") || shell.accounts[0]?.id || "criteo-demo";
  const windowId = searchParams.get("window") || shell.windows[0]?.id || "recent_7d";
  const windowLocked = Boolean(
    (pathname.startsWith("/workspace") && searchParams.get("conversation")) ||
      (pathname.startsWith("/decisions") && searchParams.get("id"))
  );

  function href(path: string, patch?: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("account", account);
    if (windowId) next.set("window", windowId);
    if (path === "/decisions") {
      next.delete("campaign");
      next.delete("id");
      next.delete("finding");
      next.delete("conversation");
      next.delete("history");
      next.delete("status");
    }
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (!value) next.delete(key);
        else next.set(key, value);
      }
    }
    const query = next.toString();
    return query ? `${path}?${query}` : path;
  }

  function pushFilters(patch: Record<string, string | null>) {
    router.push(href(pathname, { finding: null, ...patch }));
  }

  return (
    <div className={`ap-shell${collapsed ? " is-collapsed" : ""}${navOpen ? " nav-open" : ""}`}>
      {navOpen ? <button className="ap-backdrop" aria-label="Close navigation" onClick={() => setNavOpen(false)} /> : null}
      <aside className="ap-sidebar">
        <Link href={href("/overview")} className="ap-brand" onClick={() => setNavOpen(false)}>
          <Icon name="overview" />
          {collapsed ? null : <strong>AdPilot</strong>}
        </Link>
        <nav className="ap-nav" aria-label="Primary navigation">
          {NAV.map((item) => {
            const active = item.match.some((path) => pathname === path || (path !== "/overview" && pathname.startsWith(`${path}/`)));
            return (
              <Link key={item.href} href={href(item.href)} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => setNavOpen(false)}>
                <Icon name={item.icon} />
                {collapsed ? null : item.label}
              </Link>
            );
          })}
        </nav>
        <nav className="ap-nav ap-nav-secondary" aria-label="Secondary navigation">
          {SECONDARY.map((item) => <Link key={item.href} href={href(item.href)} className={pathname.startsWith(item.href) ? "active" : ""} onClick={() => setNavOpen(false)}><Icon name={item.icon} />{collapsed ? null : item.label}</Link>)}
        </nav>
      </aside>
      <div className="ap-main">
        <header className="ap-top">
          <div className="ap-top-filters">
            <button className="ap-icon-btn ap-hide-desktop" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}>☰</button>
            <button className="ap-icon-btn ap-hide-mobile" type="button" aria-label="Collapse navigation" onClick={() => setCollapsed((value) => !value)}>☰</button>
            <select className="ap-control" aria-label="Account" value={account} onChange={(event) => pushFilters({ account: event.target.value })}>
              {shell.accounts.length ? shell.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="criteo-demo">No account</option>}
            </select>
            <select className="ap-control" aria-label="Analysis window" value={windowId} onChange={(event) => pushFilters({ window: event.target.value })} disabled={!shell.windows.length || windowLocked} title={windowLocked ? "Pinned to this investigation or decision snapshot" : undefined}>
              {shell.windows.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <div className="ap-top-actions">
            <Link href={href("/data-sources")} className={`ap-badge ${shell.freshness.stale ? "warning" : "ok"}`} title="Open imported snapshot and data coverage details">{shell.freshness.label}</Link>
            <span className="ap-user-chip">{ROLE_LABEL.user}</span>
          </div>
        </header>
        <div className="ap-content">{children}</div>
      </div>
    </div>
  );
}
