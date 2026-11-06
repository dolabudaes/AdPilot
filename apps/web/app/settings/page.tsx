import { getSettings } from "@/lib/dataStore";
import { SettingsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  return <SettingsScreen settings={settings} />;
}
