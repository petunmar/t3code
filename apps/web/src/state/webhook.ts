import { createWebhookEnvironmentAtoms } from "@t3tools/client-runtime/state/webhook";

import { connectionAtomRuntime } from "../connection/runtime";

export const webhookEnvironment = createWebhookEnvironmentAtoms(connectionAtomRuntime);
