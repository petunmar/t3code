import { createFileRoute } from "@tanstack/react-router";

import { AutomationSettings } from "../components/settings/AutomationSettings";

export const Route = createFileRoute("/settings/automations")({
  component: AutomationSettings,
});
