import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type WebhookDeliveryStatus,
  type WebhookDeliverySummary,
  type WebhookDetail,
  type WebhookId,
  type WebhookSummary,
  type WebhookWorkspace,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CheckIcon,
  CopyIcon,
  HistoryIcon,
  LoaderIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WebhookIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { webhookEnvironment } from "../../state/webhook";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerFooterModeControls } from "../chat/ChatComposer";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export const POSTHOG_ERROR_PROMPT = `Investigate this PostHog exception immediately and fix its root cause in this repository. Use the fenra-monorepos PostHog skill to inspect the issue and related events before changing code. Reproduce or validate the failure where practical, implement the smallest correct fix, and run focused verification.`;

type WorkspaceKind = WebhookWorkspace["kind"];

interface WebhookDraft {
  readonly name: string;
  readonly projectId: ProjectId;
  readonly promptPrefix: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceKind: WorkspaceKind;
  readonly expectedBranch: string;
  readonly worktreePath: string;
  readonly fromBranch: string;
  readonly startFromOrigin: boolean;
  readonly enabled: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  return "An unexpected error occurred.";
}

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  return errorMessage(squashAtomCommandFailure(result));
}

function queryError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  return result._tag === "Failure" ? errorMessage(Cause.squash(result.cause)) : null;
}

function emptyDraft(projectId: ProjectId, modelSelection: ModelSelection): WebhookDraft {
  return {
    name: "PostHog errors",
    projectId,
    promptPrefix: POSTHOG_ERROR_PROMPT,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceKind: "project-checkout",
    expectedBranch: "",
    worktreePath: "",
    fromBranch: "main",
    startFromOrigin: false,
    enabled: true,
  };
}

function draftFromDetail(detail: WebhookDetail): WebhookDraft {
  const workspace = detail.workspace;
  return {
    name: detail.name,
    projectId: detail.projectId,
    promptPrefix: detail.promptPrefix,
    modelSelection: detail.modelSelection,
    runtimeMode: detail.runtimeMode,
    interactionMode: detail.interactionMode,
    workspaceKind: workspace.kind,
    expectedBranch:
      workspace.kind === "project-checkout" || workspace.kind === "existing-worktree"
        ? (workspace.expectedBranch ?? "")
        : "",
    worktreePath: workspace.kind === "existing-worktree" ? workspace.worktreePath : "",
    fromBranch: workspace.kind === "new-worktree" ? workspace.fromBranch : "main",
    startFromOrigin: workspace.kind === "new-worktree" && workspace.startFromOrigin,
    enabled: detail.enabled,
  };
}

function toWorkspace(draft: WebhookDraft): WebhookWorkspace {
  switch (draft.workspaceKind) {
    case "project-checkout":
      return { kind: "project-checkout", expectedBranch: draft.expectedBranch.trim() || null };
    case "existing-worktree":
      return {
        kind: "existing-worktree",
        worktreePath: draft.worktreePath.trim(),
        expectedBranch: draft.expectedBranch.trim() || null,
      };
    case "new-worktree":
      return {
        kind: "new-worktree",
        fromBranch: draft.fromBranch.trim(),
        startFromOrigin: draft.startFromOrigin,
      };
  }
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium text-foreground">
      <span>{label}</span>
      {children}
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function WebhookEditor({
  environmentId,
  projects,
  initial,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly initial: WebhookDetail | null;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const defaultSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const [draft, setDraft] = useState(() =>
    initial
      ? draftFromDetail(initial)
      : emptyDraft(projects[0]?.id ?? ("missing-project" as ProjectId), defaultSelection),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createWebhook = useAtomCommand(webhookEnvironment.create, { reportFailure: false });
  const updateWebhook = useAtomCommand(webhookEnvironment.update, { reportFailure: false });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const selectedEntry =
    instanceEntries.find((entry) => entry.instanceId === draft.modelSelection.instanceId) ?? null;
  const selectedProvider = selectedEntry?.driverKind ?? ProviderDriverKind.make("codex");

  const set = <K extends keyof WebhookDraft>(key: K, value: WebhookDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    if (!draft.name.trim()) return setError("Give the webhook a name.");
    if (draft.workspaceKind === "existing-worktree" && !draft.worktreePath.trim()) {
      return setError("Enter the existing worktree path.");
    }
    if (draft.workspaceKind === "new-worktree" && !draft.fromBranch.trim()) {
      return setError("Enter the branch to create the worktree from.");
    }
    setPending(true);
    setError(null);
    const fields = {
      projectId: draft.projectId,
      name: draft.name.trim(),
      promptPrefix: draft.promptPrefix,
      modelSelection: draft.modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      workspace: toWorkspace(draft),
      enabled: draft.enabled,
    } as const;
    const result = initial
      ? await updateWebhook({
          environmentId,
          input: { id: initial.id, expectedRevision: initial.revision, ...fields },
        })
      : await createWebhook({ environmentId, input: fields });
    setPending(false);
    if (result._tag === "Success") return onClose();
    setError(commandError(result));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit webhook" : "New webhook"}</DialogTitle>
          <DialogDescription>
            Every accepted request starts a fresh thread with its body appended to the prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="PostHog errors"
              />
            </Field>
            <Field label="Project">
              <Select
                value={draft.projectId}
                onValueChange={(value) => value && set("projectId", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>

          <Field
            label="Prompt prefix"
            hint="This trusted instruction is placed before the untrusted webhook body. Leave it empty to send only the body envelope."
          >
            <Textarea
              value={draft.promptPrefix}
              onChange={(event) => set("promptPrefix", event.target.value)}
              placeholder="Tell the agent how to handle this event…"
              className="min-h-36"
            />
          </Field>
          <div className="-mt-4 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => set("promptPrefix", POSTHOG_ERROR_PROMPT)}
            >
              Use PostHog error template
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="text-sm font-medium">Agent</div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 p-2">
              <ProviderModelPicker
                activeInstanceId={draft.modelSelection.instanceId}
                model={draft.modelSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                onInstanceModelChange={(instanceId, model) =>
                  set("modelSelection", createModelSelection(instanceId, model))
                }
              />
              <TraitsPicker
                provider={selectedProvider}
                instanceId={draft.modelSelection.instanceId}
                models={selectedEntry?.models ?? []}
                model={draft.modelSelection.model}
                prompt={draft.promptPrefix}
                onPromptChange={(promptPrefix) => set("promptPrefix", promptPrefix)}
                modelOptions={draft.modelSelection.options}
                allowPromptInjectedEffort
                triggerVariant="outline"
                onModelOptionsChange={(options) =>
                  set(
                    "modelSelection",
                    createModelSelection(
                      draft.modelSelection.instanceId,
                      draft.modelSelection.model,
                      options,
                    ),
                  )
                }
              />
              <ComposerFooterModeControls
                showInteractionModeToggle={settings.planModeEnabled}
                interactionMode={draft.interactionMode}
                runtimeMode={draft.runtimeMode}
                onToggleInteractionMode={() =>
                  set("interactionMode", draft.interactionMode === "plan" ? "default" : "plan")
                }
                onRuntimeModeChange={(mode) => set("runtimeMode", mode)}
              />
            </div>
          </div>

          <div className="grid gap-4">
            <Field label="Workspace">
              <Select
                value={draft.workspaceKind}
                onValueChange={(value) => value && set("workspaceKind", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="project-checkout">Use project checkout</SelectItem>
                  <SelectItem value="existing-worktree">Use existing worktree</SelectItem>
                  <SelectItem value="new-worktree">
                    Create a new worktree for every delivery
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.workspaceKind === "existing-worktree" ? (
              <Field label="Worktree path">
                <Input
                  value={draft.worktreePath}
                  onChange={(event) => set("worktreePath", event.target.value)}
                  placeholder="/path/to/worktree"
                />
              </Field>
            ) : null}
            {draft.workspaceKind === "new-worktree" ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field label="From branch">
                  <Input
                    value={draft.fromBranch}
                    onChange={(event) => set("fromBranch", event.target.value)}
                    placeholder="main"
                  />
                </Field>
                <label className="flex h-8 items-center gap-2 text-sm">
                  <Switch
                    checked={draft.startFromOrigin}
                    onCheckedChange={(checked) => set("startFromOrigin", Boolean(checked))}
                  />
                  Start from origin
                </label>
              </div>
            ) : (
              <Field
                label="Expected branch"
                hint="Optional. The same branch-collision checks as a normal chat apply."
              >
                <Input
                  value={draft.expectedBranch}
                  onChange={(event) => set("expectedBranch", event.target.value)}
                  placeholder="Current branch"
                />
              </Field>
            )}
          </div>

          <label className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Enabled</span>
              <span className="block text-xs text-muted-foreground">
                Paused webhooks keep their configuration and delivery history.
              </span>
            </span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => set("enabled", Boolean(checked))}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={pending || projects.length === 0}
          >
            {pending ? <LoaderIcon className="size-4 animate-spin" /> : null}
            {initial ? "Save changes" : "Create webhook"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EditWebhookDialog({
  environmentId,
  webhookId,
  projects,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly webhookId: WebhookId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(
    webhookEnvironment.detail({ environmentId, input: { id: webhookId } }),
  );
  const detail = Option.getOrNull(AsyncResult.value(result));
  if (detail === null) {
    const failure = queryError(result);
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit webhook</DialogTitle>
          </DialogHeader>
          <DialogPanel className="flex min-h-32 items-center justify-center">
            {failure ? (
              <p className="text-sm text-destructive">{failure}</p>
            ) : (
              <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    );
  }
  return (
    <WebhookEditor
      environmentId={environmentId}
      projects={projects}
      initial={detail}
      onClose={onClose}
    />
  );
}

function DeliveryHistoryDialog({
  environmentId,
  webhook,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly webhook: WebhookSummary;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const result = useAtomValue(
    webhookEnvironment.deliveries({ environmentId, input: { webhookId: webhook.id, limit: 50 } }),
  );
  const page = Option.getOrNull(AsyncResult.value(result));
  const failure = queryError(result);
  const openDelivery = (delivery: WebhookDeliverySummary) => {
    if (delivery.threadId === null) return;
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: delivery.threadId },
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{webhook.name} history</DialogTitle>
          <DialogDescription>
            Retries with the same delivery identifier appear only once.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-1">
          {page === null ? (
            <div className="flex min-h-32 items-center justify-center">
              {failure ? (
                <p className="text-sm text-destructive">{failure}</p>
              ) : (
                <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
              )}
            </div>
          ) : page.deliveries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No deliveries yet.</p>
          ) : (
            page.deliveries.map((delivery) => (
              <button
                key={delivery.id}
                type="button"
                disabled={delivery.threadId === null}
                onClick={() => openDelivery(delivery)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-lg px-3 py-2.5 text-left hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="min-w-0 truncate text-sm font-medium capitalize">
                  {delivery.status}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(delivery.receivedAt).toLocaleString()}
                </span>
                <span className="col-span-2 text-xs text-muted-foreground">
                  {delivery.detail ?? (delivery.threadId ? "Open thread" : "No thread")}
                </span>
              </button>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function liveDeliveryStatus(
  webhook: WebhookSummary,
  threadById: ReadonlyMap<string, ReturnType<typeof useThreadShells>[number]>,
): WebhookDeliveryStatus {
  const persisted = webhook.lastDelivery?.status ?? "completed";
  const threadId = webhook.lastDelivery?.threadId;
  if (!threadId) return persisted;
  const thread = threadById.get(threadId);
  if (!thread) return persisted;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  )
    return "running";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "failed";
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted")
    return "interrupted";
  if (
    thread.latestTurn?.state === "completed" ||
    thread.session?.status === "idle" ||
    thread.session?.status === "ready" ||
    thread.session?.status === "stopped"
  )
    return "completed";
  return persisted;
}

function absoluteWebhookUrl(baseUrl: string | null, endpointPath: string): string {
  if (!baseUrl) return endpointPath;
  try {
    return new URL(endpointPath, baseUrl).toString();
  } catch {
    return endpointPath;
  }
}

export function EnvironmentWebhooks({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}) {
  const threads = useThreadShells();
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const result = useAtomValue(webhookEnvironment.changes({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const snapshotError = queryError(result);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<WebhookId | null>(null);
  const [history, setHistory] = useState<WebhookSummary | null>(null);
  const [pendingId, setPendingId] = useState<WebhookId | null>(null);
  const [copiedId, setCopiedId] = useState<WebhookId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pause = useAtomCommand(webhookEnvironment.pause, { reportFailure: false });
  const resume = useAtomCommand(webhookEnvironment.resume, { reportFailure: false });
  const rotateSecret = useAtomCommand(webhookEnvironment.rotateSecret, { reportFailure: false });
  const remove = useAtomCommand(webhookEnvironment.delete, { reportFailure: false });
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );
  const threadById = useMemo(
    () =>
      new Map(
        threads
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => [thread.id, thread] as const),
      ),
    [environmentId, threads],
  );

  const copyUrl = async (webhook: WebhookSummary) => {
    try {
      await navigator.clipboard.writeText(absoluteWebhookUrl(httpBaseUrl, webhook.endpointPath));
      setCopiedId(webhook.id);
      setError(null);
      window.setTimeout(() => setCopiedId((id) => (id === webhook.id ? null : id)), 1500);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const runAction = async (
    webhook: WebhookSummary,
    action: "pause" | "resume" | "rotate" | "delete",
  ) => {
    if (
      action === "delete" &&
      !window.confirm(`Delete “${webhook.name}” and its delivery history?`)
    )
      return;
    if (
      action === "rotate" &&
      !window.confirm(
        `Rotate the URL for “${webhook.name}”? The old URL will stop working immediately.`,
      )
    )
      return;
    setPendingId(webhook.id);
    setError(null);
    const input = { id: webhook.id, expectedRevision: webhook.revision };
    const response =
      action === "pause"
        ? await pause({ environmentId, input })
        : action === "resume"
          ? await resume({ environmentId, input })
          : action === "rotate"
            ? await rotateSecret({ environmentId, input })
            : await remove({ environmentId, input });
    setPendingId(null);
    if (response._tag !== "Success") setError(commandError(response));
  };

  return (
    <>
      <SettingsSection
        id="webhooks"
        title="Webhooks"
        icon={<WebhookIcon className="size-5 text-violet-500" />}
        headerAction={
          <Button size="sm" onClick={() => setCreating(true)} disabled={projects.length === 0}>
            <PlusIcon className="size-4" /> New webhook
          </Button>
        }
      >
        {snapshot === null ? (
          <SettingsRow
            title={
              snapshotError ? (
                "Could not load webhooks"
              ) : (
                <span className="inline-flex items-center gap-2">
                  <LoaderIcon className="size-3.5 animate-spin" />
                  Loading webhooks
                </span>
              )
            }
            description={snapshotError ?? "Reading webhook definitions from this environment."}
          />
        ) : snapshot.webhooks.length === 0 ? (
          <SettingsRow
            title="No webhooks"
            description="Create one to start a fresh agent thread from an HTTP POST request."
          />
        ) : (
          snapshot.webhooks.map((webhook) => {
            const status = liveDeliveryStatus(webhook, threadById);
            const pending = pendingId === webhook.id;
            return (
              <SettingsRow
                key={webhook.id}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{webhook.name}</span>
                    {!webhook.enabled ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Paused
                      </span>
                    ) : null}
                  </span>
                }
                description={`${projectNames.get(webhook.projectId) ?? "Unknown project"} · POST ${webhook.endpointPath}`}
                status={
                  webhook.lastDelivery
                    ? `Last ${status} ${formatRelativeTimeLabel(webhook.lastDelivery.receivedAt)}`
                    : "No deliveries yet"
                }
                control={
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Copy URL for ${webhook.name}`}
                      title="Copy webhook URL"
                      onClick={() => void copyUrl(webhook)}
                    >
                      {copiedId === webhook.id ? <CheckIcon /> : <CopyIcon />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`View ${webhook.name} history`}
                      onClick={() => setHistory(webhook)}
                    >
                      <HistoryIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${webhook.name}`}
                      onClick={() => setEditingId(webhook.id)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Rotate URL for ${webhook.name}`}
                      title="Rotate URL"
                      disabled={pending}
                      onClick={() => void runAction(webhook, "rotate")}
                    >
                      {pending ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={
                        webhook.enabled ? `Pause ${webhook.name}` : `Resume ${webhook.name}`
                      }
                      disabled={pending}
                      onClick={() => void runAction(webhook, webhook.enabled ? "pause" : "resume")}
                    >
                      {webhook.enabled ? <PauseIcon /> : <PlayIcon />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${webhook.name}`}
                      disabled={pending}
                      onClick={() => void runAction(webhook, "delete")}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
        {error ? <p className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
      </SettingsSection>

      <SettingsSection
        title="Webhook delivery"
        icon={<WebhookIcon className="size-5 text-muted-foreground" />}
      >
        <SettingsRow
          title="Secret URL"
          description="The URL is a credential. Rotate it immediately if it is exposed; requests do not need a T3 client session."
        />
        <SettingsRow
          title="Retry safe"
          description="Set X-T3-Delivery-ID to a stable event ID so provider retries create only one thread. Without it, every request is a new delivery."
        />
        <SettingsRow
          title="PostHog errors"
          description="Use a real-time HTTP destination matching $exception. PostHog can send a custom JSON body and X-T3-Delivery-ID header."
        />
      </SettingsSection>

      {creating ? (
        <WebhookEditor
          environmentId={environmentId}
          projects={projects}
          initial={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editingId ? (
        <EditWebhookDialog
          environmentId={environmentId}
          webhookId={editingId}
          projects={projects}
          onClose={() => setEditingId(null)}
        />
      ) : null}
      {history ? (
        <DeliveryHistoryDialog
          environmentId={environmentId}
          webhook={history}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </>
  );
}
