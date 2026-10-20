/** Settings sections, in nav order; the id is the URL segment. */
export const SETTINGS_SECTIONS = [
  { id: "connections", label: "Connections" },
  { id: "repositories", label: "Repositories" },
  { id: "agents", label: "Agent library" },
  { id: "tags", label: "Tags" },
  { id: "defaults", label: "Defaults" },
  { id: "backlog", label: "Backlog" },
  { id: "notifications", label: "Notifications" },
  { id: "voice", label: "Voice" },
  { id: "data", label: "Data" },
  { id: "system", label: "System" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}
