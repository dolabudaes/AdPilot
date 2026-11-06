"use client";

import { can, type Role } from "@/lib/copilot/permissions";
import type { InvestigationSidebarGroup, InvestigationSidebarRow } from "@/lib/copilot/workspace-nav";

export function InvestigationSidebar({
  groups,
  resultCount,
  campaignQuery,
  onCampaignQuery,
  sidebarFilter,
  onSidebarFilter,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileClose,
  activeConversationId,
  busy,
  role,
  onNewInvestigation,
  onSelect,
  onDelete,
}: {
  groups: InvestigationSidebarGroup[];
  resultCount: number;
  campaignQuery: string;
  onCampaignQuery: (value: string) => void;
  sidebarFilter: "recent" | "all";
  onSidebarFilter: (value: "recent" | "all") => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  activeConversationId?: string | null;
  busy: boolean;
  role: Role;
  onNewInvestigation: () => void;
  onSelect: (row: InvestigationSidebarRow) => void;
  onDelete?: (row: InvestigationSidebarRow) => void;
}) {
  return (
    <aside className={`ap-ws-conversations${mobileOpen ? " is-mobile-open" : ""}`} aria-label="Investigation navigation">
      <div className="ap-ws-conv-head">
        <div className="ap-ws-conv-head-row">
          <p className="ap-eyebrow">Investigations</p>
          <button type="button" className="ap-icon-btn ap-desktop-sidebar-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed}>
            {collapsed ? "›" : "‹"}
          </button>
          <button type="button" className="ap-icon-btn ap-mobile-sidebar-close" aria-label="Close investigations" onClick={onMobileClose}>×</button>
        </div>
        {!collapsed ? (
          <>
            <div className="ap-history-search-wrap">
              <input className="ap-history-search" placeholder="Search investigations" value={campaignQuery} onChange={(e) => onCampaignQuery(e.target.value)} aria-label="Search investigations" />
              <span>{resultCount}</span>
            </div>
            <div className="ap-ws-filter-row ap-ws-filter-row--compact">
              {(["recent", "all"] as const).map((id) => (
                <button key={id} type="button" className={sidebarFilter === id ? "is-active" : ""} onClick={() => onSidebarFilter(id)}>
                  {id === "recent" ? "Recent" : "All"}
                </button>
              ))}
            </div>
            <button type="button" className="ap-btn primary ap-ws-new-chat" disabled={busy || !can(role, "converse")} onClick={onNewInvestigation}>
              New investigation
            </button>
          </>
        ) : null}
      </div>
      {!collapsed ? (
        <div className="ap-ws-inv-list" aria-label={`${resultCount} investigations`}>
          {groups.length ? groups.map((group) => (
            <section className="ap-ws-inv-group" key={group.campaignId}>
              <header><h2>{group.campaignName}</h2><span>{group.rows.length}</span></header>
              <div>
                {group.rows.map((row) => {
                  const active = activeConversationId === row.conversation.id;
                  const canDelete = Boolean(onDelete) && can(role, "converse") && !busy;
                  return (
                    <div key={row.conversation.id} className={`ap-ws-inv-row-wrap${active ? " is-active" : ""}`}>
                      <button
                        type="button"
                        className={`ap-ws-inv-row${active ? " is-active" : ""}`}
                        onClick={() => onSelect(row)}
                      >
                        <span className="ap-ws-inv-issue">{row.issueTitle}</span>
                        <span className="ap-ws-inv-window">{row.windowLabel}</span>
                        <span className="ap-ws-inv-meta">{row.updatedLabel}</span>
                      </button>
                      {canDelete ? (
                        <button
                          type="button"
                          className="ap-ws-inv-delete"
                          aria-label={`Delete ${row.issueTitle}`}
                          title="Delete investigation"
                          disabled={busy}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onDelete?.(row);
                          }}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          )) : <p className="ap-ws-history-empty">No recorded investigations yet. Start a new investigation to analyze a campaign question.</p>}
        </div>
      ) : null}
    </aside>
  );
}
