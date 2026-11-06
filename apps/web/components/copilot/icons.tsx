export function Icon({ name }: { name: string }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true as const };
  if (name === "overview") return <svg {...common}><path d="M4 13h6V4H4v9Zm10 7h6V4h-6v16ZM4 20h6v-5H4v5Z" /></svg>;
  if (name === "workspace") return <svg {...common}><path d="M12 3v3M5 8h14v11H5V8Zm4 4h6M9 15h3" /></svg>;
  if (name === "campaigns") return <svg {...common}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
  if (name === "decisions") return <svg {...common}><path d="M7 4h10v16H7V4Zm3 4h4M10 12h4M10 16h3" /></svg>;
  if (name === "data") return <svg {...common}><path d="M12 3c4 0 7 1.2 7 3s-3 3-7 3-7-1.2-7-3 3-3 7-3Zm7 6c0 1.8-3 3-7 3s-7-1.2-7-3m14 5c0 1.8-3 3-7 3s-7-1.2-7-3" /></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></svg>;
  if (name === "copilot") return <svg {...common}><path d="M5 6h14v9H8l-3 3V6Z" /></svg>;
  if (name === "bell") return <svg {...common}><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 3a2 2 0 0 0 4 0" /></svg>;
  return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5 19c1.5-3 3.8-4 7-4s5.5 1 7 4" /></svg>;
}
