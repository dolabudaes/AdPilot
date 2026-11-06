import "./globals.css";
import "./copilot.css";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "./shell";
import { getShellModel } from "@/lib/copilot/shell-data";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "AdPilot",
  description: "AI-assisted advertising analysis and decision workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const shell = getShellModel();
  return (
    <html lang="en">
      <body>
        <Suspense fallback={<div className="ap-boot">Opening AdPilot…</div>}>
          <AppShell shell={shell}>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
