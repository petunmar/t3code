import { useAtomValue } from "@effect/atom-react";
import {
  type AutomationAttachmentWrite,
  type AutomationDetail,
  type AutomationId,
  type AutomationRunSummary,
  type AutomationRunStatus,
  type AutomationSummary,
  type AutomationWorkspace,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CalendarClockIcon,
  Clock3Icon,
  FileIcon,
  HistoryIcon,
  LoaderIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

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
import { automationEnvironment } from "../../state/automation";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readFileAsDataUrl } from "../ChatView.logic";
import { randomUUID } from "../../lib/utils";
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
import { cn } from "~/lib/utils";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { EnvironmentWebhooks } from "./WebhookSettings";

const DEFAULT_CRON = "0 9 * * 1-5";
const ACTIVE_RUN_STATUSES = new Set(["launching", "running", "waiting"]);

type WorkspaceKind = AutomationWorkspace["kind"];

type DraftAttachment =
  | {
      readonly key: string;
      readonly kind: "retained";
      readonly id: string;
      readonly name: string;
      readonly sizeBytes: number;
    }
  | {
      readonly key: string;
      readonly kind: "upload";
      readonly attachment: UploadChatAttachment;
    };

interface AutomationDraft {
  readonly name: string;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceKind: WorkspaceKind;
  readonly expectedBranch: string;
  readonly worktreePath: string;
  readonly fromBranch: string;
  readonly startFromOrigin: boolean;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly enabled: boolean;
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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

function emptyDraft(projectId: ProjectId, modelSelection: ModelSelection): AutomationDraft {
  return {
    name: "",
    projectId,
    prompt: "",
    attachments: [],
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceKind: "project-checkout",
    expectedBranch: "",
    worktreePath: "",
    fromBranch: "main",
    startFromOrigin: false,
    cronExpression: DEFAULT_CRON,
    timeZone: localTimeZone(),
    enabled: true,
  };
}

function draftFromDetail(detail: AutomationDetail): AutomationDraft {
  const workspace = detail.workspace;
  return {
    name: detail.name,
    projectId: detail.projectId,
    prompt: detail.message.text,
    attachments: detail.message.attachments.map((attachment) => ({
      key: attachment.id,
      kind: "retained" as const,
      id: attachment.id,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
    })),
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
    cronExpression: detail.schedule.cronExpression,
    timeZone: detail.schedule.timeZone,
    enabled: detail.enabled,
  };
}

function toWorkspace(draft: AutomationDraft): AutomationWorkspace {
  switch (draft.workspaceKind) {
    case "project-checkout":
      return {
        kind: "project-checkout",
        expectedBranch: draft.expectedBranch.trim() || null,
      };
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

function toAttachmentWrite(attachment: DraftAttachment): AutomationAttachmentWrite {
  return attachment.kind === "retained"
    ? { kind: "retained", attachmentId: attachment.id }
    : { kind: "upload", attachment: attachment.attachment };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: string | null): string {
  if (value === null) return "Not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function liveRunStatus(
  automation: AutomationSummary,
  threadById: ReadonlyMap<string, ReturnType<typeof useThreadShells>[number]>,
): AutomationRunStatus {
  const persisted = automation.lastRun?.status ?? "completed";
  const threadId = automation.lastRun?.threadId;
  if (threadId === null || threadId === undefined) return persisted;
  const thread = threadById.get(threadId);
  if (!thread) return persisted;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness === "working" ||
    thread.backgroundLiveness === "monitoring"
  ) {
    return "running";
  }
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "failed";
  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return "interrupted";
  }
  if (
    thread.latestTurn?.state === "completed" ||
    thread.session?.status === "idle" ||
    thread.session?.status === "ready" ||
    thread.session?.status === "stopped"
  ) {
    return "completed";
  }
  return persisted;
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

function AutomationEditor({
  environmentId,
  projects,
  initial,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReturnType<typeof useProjects>;
  readonly initial: AutomationDetail | null;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createAutomation = useAtomCommand(automationEnvironment.create, { reportFailure: false });
  const updateAutomation = useAtomCommand(automationEnvironment.update, { reportFailure: false });

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

  const set = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const addAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (draft.attachments.length + files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setError(`A prompt can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`);
      return;
    }
    const tooLarge = files.find((file) => file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    if (tooLarge) {
      setError(
        `${tooLarge.name} exceeds the ${formatBytes(PROVIDER_SEND_TURN_MAX_FILE_BYTES)} limit.`,
      );
      return;
    }
    try {
      const uploads = await Promise.all(
        files.map(async (file) => {
          const mimeType = file.type || "application/octet-stream";
          const attachment: UploadChatAttachment = {
            type: mimeType.startsWith("image/") ? "image" : "file",
            name: file.name,
            mimeType,
            sizeBytes: file.size,
            dataUrl: await readFileAsDataUrl(file),
          };
          return {
            key: `${file.name}:${file.size}:${randomUUID()}`,
            kind: "upload" as const,
            attachment,
          };
        }),
      );
      set("attachments", [...draft.attachments, ...uploads]);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const validate = (): string | null => {
    if (!draft.name.trim()) return "Give the automation a name.";
    if (!draft.prompt.trim() && draft.attachments.length === 0) {
      return "Add a prompt or attachment.";
    }
    if (!draft.cronExpression.trim()) return "Enter a CRON expression.";
    if (!draft.timeZone.trim()) return "Enter an IANA time zone.";
    if (draft.workspaceKind === "existing-worktree" && !draft.worktreePath.trim()) {
      return "Enter the existing worktree path.";
    }
    if (draft.workspaceKind === "new-worktree" && !draft.fromBranch.trim()) {
      return "Enter the branch to create the worktree from.";
    }
    return null;
  };

  const save = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setPending(true);
    setError(null);
    const fields = {
      projectId: draft.projectId,
      name: draft.name.trim(),
      message: {
        text: draft.prompt,
        attachments: draft.attachments.map(toAttachmentWrite),
      },
      modelSelection: draft.modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      workspace: toWorkspace(draft),
      schedule: {
        cronExpression: draft.cronExpression.trim(),
        timeZone: draft.timeZone.trim(),
      },
      enabled: draft.enabled,
    } as const;
    const result = initial
      ? await updateAutomation({
          environmentId,
          input: { id: initial.id, expectedRevision: initial.revision, ...fields },
        })
      : await createAutomation({ environmentId, input: fields });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      return;
    }
    setError(commandError(result));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            Each occurrence starts a fresh thread with this configuration. Runs never overlap.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Daily issue triage"
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

          <Field label="Prompt" hint="This is sent as the first message in every fresh thread.">
            <Textarea
              value={draft.prompt}
              onChange={(event) => set("prompt", event.target.value)}
              placeholder="Describe the work this agent should do…"
              className="min-h-32"
            />
          </Field>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Attachments</div>
                <div className="text-xs text-muted-foreground">
                  Stored once and copied into each run.
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={draft.attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS}
              >
                <UploadIcon className="size-3.5" /> Add files
              </Button>
              <input ref={fileInputRef} hidden multiple type="file" onChange={addAttachments} />
            </div>
            {draft.attachments.length > 0 ? (
              <div className="grid gap-1 rounded-lg border border-border/70 p-2">
                {draft.attachments.map((attachment) => {
                  const name =
                    attachment.kind === "retained" ? attachment.name : attachment.attachment.name;
                  const sizeBytes =
                    attachment.kind === "retained"
                      ? attachment.sizeBytes
                      : attachment.attachment.sizeBytes;
                  return (
                    <div
                      key={attachment.key}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                    >
                      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(sizeBytes)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${name}`}
                        onClick={() =>
                          set(
                            "attachments",
                            draft.attachments.filter((item) => item.key !== attachment.key),
                          )
                        }
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
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
                prompt={draft.prompt}
                onPromptChange={(prompt) => set("prompt", prompt)}
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
                  <SelectItem value="new-worktree">Create a new worktree for every run</SelectItem>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="CRON schedule"
              hint="Standard 5-field CRON: minute hour day-of-month month day-of-week."
            >
              <Input
                value={draft.cronExpression}
                onChange={(event) => set("cronExpression", event.target.value)}
                placeholder={DEFAULT_CRON}
                className="font-mono"
              />
            </Field>
            <Field label="Time zone" hint="Use an IANA name such as Europe/London.">
              <Input
                value={draft.timeZone}
                onChange={(event) => set("timeZone", event.target.value)}
                placeholder="UTC"
              />
            </Field>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium">Enabled</span>
              <span className="block text-xs text-muted-foreground">
                Disabled automations keep their definition and run history.
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
            {initial ? "Save changes" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EditAutomationDialog({
  environmentId,
  automationId,
  projects,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly automationId: AutomationId;
  readonly projects: ReturnType<typeof useProjects>;
  readonly onClose: () => void;
}) {
  const result = useAtomValue(
    automationEnvironment.detail({ environmentId, input: { id: automationId } }),
  );
  const detail = Option.getOrNull(AsyncResult.value(result));
  if (detail === null) {
    const failure = queryError(result);
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Edit automation</DialogTitle>
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
    <AutomationEditor
      environmentId={environmentId}
      projects={projects}
      initial={detail}
      onClose={onClose}
    />
  );
}

function RunHistoryDialog({
  environmentId,
  automation,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly automation: AutomationSummary;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const result = useAtomValue(
    automationEnvironment.runs({
      environmentId,
      input: { automationId: automation.id, limit: 50 },
    }),
  );
  const page = Option.getOrNull(AsyncResult.value(result));
  const failure = queryError(result);
  const openRun = (run: AutomationRunSummary) => {
    if (run.threadId === null) return;
    onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: run.threadId },
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{automation.name} history</DialogTitle>
          <DialogDescription>Every occurrence gets its own fresh thread.</DialogDescription>
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
          ) : page.runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            page.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                disabled={run.threadId === null}
                onClick={() => openRun(run)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 rounded-lg px-3 py-2.5 text-left hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="min-w-0 truncate text-sm font-medium capitalize">
                  {run.status} · {run.trigger}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(run.triggeredAt)}
                </span>
                <span className="col-span-2 text-xs text-muted-foreground">
                  {run.detail ??
                    (run.missedOccurrences.value > 1
                      ? `${run.missedOccurrences.value} occurrences coalesced`
                      : run.threadId
                        ? "Open thread"
                        : "No thread")}
                </span>
              </button>
            ))
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentAutomations({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReturnType<typeof useProjects>;
}) {
  const threads = useThreadShells();
  const result = useAtomValue(automationEnvironment.changes({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const snapshotError = queryError(result);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<AutomationId | null>(null);
  const [history, setHistory] = useState<AutomationSummary | null>(null);
  const [pendingId, setPendingId] = useState<AutomationId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pause = useAtomCommand(automationEnvironment.pause, { reportFailure: false });
  const resume = useAtomCommand(automationEnvironment.resume, { reportFailure: false });
  const remove = useAtomCommand(automationEnvironment.delete, { reportFailure: false });
  const runNow = useAtomCommand(automationEnvironment.runNow, { reportFailure: false });
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

  const runAction = async (
    automation: AutomationSummary,
    action: "pause" | "resume" | "delete" | "run",
  ) => {
    if (
      action === "delete" &&
      !window.confirm(`Delete “${automation.name}” and its run history?`)
    ) {
      return;
    }
    setPendingId(automation.id);
    setError(null);
    const target = { environmentId } as const;
    const response =
      action === "pause"
        ? await pause({
            ...target,
            input: { id: automation.id, expectedRevision: automation.revision },
          })
        : action === "resume"
          ? await resume({
              ...target,
              input: { id: automation.id, expectedRevision: automation.revision },
            })
          : action === "delete"
            ? await remove({
                ...target,
                input: { id: automation.id, expectedRevision: automation.revision },
              })
            : await runNow({ ...target, input: { id: automation.id } });
    setPendingId(null);
    if (response._tag !== "Success") setError(commandError(response));
  };

  return (
    <>
      <SettingsSection
        id="automations"
        title="Automations"
        icon={<CalendarClockIcon className="size-5 text-blue-500" />}
        headerAction={
          <Button size="sm" onClick={() => setCreating(true)} disabled={projects.length === 0}>
            <PlusIcon className="size-4" /> New automation
          </Button>
        }
      >
        {snapshot === null ? (
          <SettingsRow
            title={
              snapshotError ? (
                "Could not load automations"
              ) : (
                <span className="inline-flex items-center gap-2">
                  <LoaderIcon className="size-3.5 animate-spin" />
                  Loading automations
                </span>
              )
            }
            description={snapshotError ?? "Reading schedules from this environment."}
          />
        ) : snapshot.automations.length === 0 ? (
          <SettingsRow
            title="No automations"
            description="Create one to start a fresh agent thread on a CRON schedule."
          />
        ) : (
          snapshot.automations.map((automation) => {
            const lastRunStatus = liveRunStatus(automation, threadById);
            const active = automation.lastRun !== null && ACTIVE_RUN_STATUSES.has(lastRunStatus);
            const pending = pendingId === automation.id;
            return (
              <SettingsRow
                key={automation.id}
                title={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{automation.name}</span>
                    {!automation.enabled ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Paused
                      </span>
                    ) : active ? (
                      <span className="rounded-full bg-blue-500/12 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400">
                        Running
                      </span>
                    ) : null}
                  </span>
                }
                description={`${projectNames.get(automation.projectId) ?? "Unknown project"} · ${automation.schedule.cronExpression} · ${automation.schedule.timeZone}`}
                status={
                  <span
                    className={cn(
                      automation.pauseReason === "configuration-error" && "text-destructive",
                    )}
                  >
                    {automation.pauseDetail ??
                      (automation.enabled
                        ? `Next run ${formatDateTime(automation.nextRunAt)}`
                        : "Schedule paused")}
                    {automation.lastRun
                      ? ` · Last ${lastRunStatus} ${formatRelativeTimeLabel(automation.lastRun.triggeredAt)}`
                      : ""}
                  </span>
                }
                control={
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Run ${automation.name} now`}
                      title={active ? "A run is already active" : "Run now"}
                      disabled={pending || active}
                      onClick={() => void runAction(automation, "run")}
                    >
                      {pending ? <LoaderIcon className="animate-spin" /> : <PlayIcon />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`View ${automation.name} history`}
                      onClick={() => setHistory(automation)}
                    >
                      <HistoryIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${automation.name}`}
                      onClick={() => setEditingId(automation.id)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={
                        automation.enabled
                          ? `Pause ${automation.name}`
                          : `Resume ${automation.name}`
                      }
                      disabled={pending}
                      onClick={() =>
                        void runAction(automation, automation.enabled ? "pause" : "resume")
                      }
                    >
                      {automation.enabled ? <PauseIcon /> : <PlayIcon />}
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${automation.name}`}
                      disabled={pending}
                      onClick={() => void runAction(automation, "delete")}
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
        title="How schedules run"
        icon={<Clock3Icon className="size-5 text-muted-foreground" />}
      >
        <SettingsRow
          title="Fresh thread every time"
          description="A run starts exactly like a normal chat with the saved project, model, access, workspace, branch, prompt, and attachments."
        />
        <SettingsRow
          title="Runs never overlap"
          description="If the previous run is still active, the scheduled occurrence is recorded as skipped. Run now is also disabled while active."
        />
        <SettingsRow
          title="Missed schedules coalesce"
          description="After downtime, the environment starts one catch-up run rather than replaying every missed occurrence."
        />
      </SettingsSection>

      {creating ? (
        <AutomationEditor
          environmentId={environmentId}
          projects={projects}
          initial={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editingId ? (
        <EditAutomationDialog
          environmentId={environmentId}
          automationId={editingId}
          projects={projects}
          onClose={() => setEditingId(null)}
        />
      ) : null}
      {history ? (
        <RunHistoryDialog
          environmentId={environmentId}
          automation={history}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </>
  );
}

export function AutomationSettings() {
  const allProjects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const supportedEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.automations === true &&
          allProjects.some((project) => project.environmentId === environment.environmentId),
      ),
    [allProjects, environments],
  );
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);

  useEffect(() => {
    if (
      environmentId &&
      supportedEnvironments.some((item) => item.environmentId === environmentId)
    ) {
      return;
    }
    const next =
      supportedEnvironments.find((item) => item.environmentId === primaryEnvironmentId) ??
      supportedEnvironments[0] ??
      null;
    setEnvironmentId(next?.environmentId ?? null);
  }, [environmentId, primaryEnvironmentId, supportedEnvironments]);

  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const supportsWebhooks =
    supportedEnvironments.find((environment) => environment.environmentId === environmentId)
      ?.serverConfig?.environment.capabilities.webhooks === true;

  return (
    <SettingsPageContainer>
      {supportedEnvironments.length > 1 ? (
        <SettingsSection title="Environment">
          <SettingsRow
            title="Automation host"
            description="Schedules run on the selected environment, even when this client is disconnected."
            control={
              <Select
                value={environmentId ?? undefined}
                onValueChange={(value) => value && setEnvironmentId(value)}
              >
                <SelectTrigger className="min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {supportedEnvironments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      {environmentId ? (
        <>
          <EnvironmentAutomations environmentId={environmentId} projects={projects} />
          {supportsWebhooks ? (
            <EnvironmentWebhooks environmentId={environmentId} projects={projects} />
          ) : null}
        </>
      ) : (
        <SettingsSection
          title="Automations"
          icon={<CalendarClockIcon className="size-5 text-blue-500" />}
        >
          <SettingsRow
            title="No compatible environment"
            description="Connect to an environment that supports automations and has at least one project."
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
