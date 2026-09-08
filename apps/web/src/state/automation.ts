import { createAutomationEnvironmentAtoms } from "@t3tools/client-runtime/state/automation";

import { connectionAtomRuntime } from "../connection/runtime";

export const automationEnvironment = createAutomationEnvironmentAtoms(connectionAtomRuntime);
