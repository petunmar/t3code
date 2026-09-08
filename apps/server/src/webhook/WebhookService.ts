// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off -- SQL JSON columns and webhook payload metadata use native boundary representations.
import {
  type WebhookCreateInput,
  type WebhookDeliveriesPage,
  type WebhookDeliveriesPageInput,
  type WebhookDeliveryStatus,
  type WebhookDeliverySummary,
  WebhookDetail,
  WebhookDeliveryId,
  type WebhookDeliveryId as WebhookDeliveryIdType,
  WebhookId,
  type WebhookId as WebhookIdType,
  type WebhookRevisionInput,
  WebhookRpcError,
  type WebhookSnapshot,
  type WebhookStreamEvent,
  type WebhookSummary,
  type WebhookUpdateInput,
  WebhookWorkspace,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const WebhookDbRow = Schema.Struct({
  id: WebhookId,
  projectId: Schema.String,
  name: Schema.String,
  promptPrefix: Schema.String,
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: Schema.fromJsonString(WebhookWorkspace),
  secretHash: Schema.String,
  enabled: Schema.Number,
  revision: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
type WebhookDbRow = typeof WebhookDbRow.Type;
const decodeWebhookDbRow = Schema.decodeUnknownEffect(WebhookDbRow);

const WebhookDeliveryDbRow = Schema.Struct({
  id: WebhookDeliveryId,
  webhookId: WebhookId,
  threadId: Schema.NullOr(Schema.String),
  storedStatus: Schema.Literals(["launching", "running", "failed"]),
  receivedAt: Schema.String,
  definitionRevision: Schema.Number,
  payloadBytes: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  sessionStatus: Schema.NullOr(Schema.String),
  turnState: Schema.NullOr(Schema.String),
  pendingApprovalCount: Schema.NullOr(Schema.Number),
  pendingUserInputCount: Schema.NullOr(Schema.Number),
  threadDeletedAt: Schema.NullOr(Schema.String),
});
type WebhookDeliveryDbRow = typeof WebhookDeliveryDbRow.Type;
const decodeWebhookDeliveryDbRow = Schema.decodeUnknownEffect(WebhookDeliveryDbRow);
const isWebhookRpcError = Schema.is(WebhookRpcError);

function storageError(message: string): WebhookRpcError {
  return new WebhookRpcError({ code: "storage-error", message });
}

function decodeError(message: string) {
  return (cause: unknown) =>
    new WebhookRpcError({
      code: "storage-error",
      message: cause instanceof Error ? `${message}: ${cause.message}` : message,
    });
}

function secretName(id: WebhookIdType): string {
  return `webhook-${id}`;
}

function endpointPath(id: WebhookIdType, token: string): string {
  return `/api/webhooks/${encodeURIComponent(id)}/${encodeURIComponent(token)}`;
}

function deriveDeliveryStatus(row: WebhookDeliveryDbRow): WebhookDeliveryStatus {
  if (row.storedStatus === "failed") return "failed";
  if (row.threadId === null) return "launching";
  if ((row.pendingApprovalCount ?? 0) > 0 || (row.pendingUserInputCount ?? 0) > 0) {
    return "waiting";
  }
  if (row.sessionStatus === "starting" || row.sessionStatus === "running") return "running";
  if (row.turnState === "error" || row.sessionStatus === "error") return "failed";
  if (row.turnState === "interrupted" || row.sessionStatus === "interrupted") {
    return "interrupted";
  }
  if (
    row.turnState === "completed" ||
    row.sessionStatus === "idle" ||
    row.sessionStatus === "ready" ||
    row.sessionStatus === "stopped" ||
    row.threadDeletedAt !== null
  ) {
    return "completed";
  }
  return "running";
}

function toDeliverySummary(row: WebhookDeliveryDbRow): WebhookDeliverySummary {
  return {
    id: row.id,
    webhookId: row.webhookId,
    threadId: row.threadId as WebhookDeliverySummary["threadId"],
    status: deriveDeliveryStatus(row),
    receivedAt: row.receivedAt,
    definitionRevision: Math.max(1, row.definitionRevision),
    payloadBytes: Math.max(0, row.payloadBytes),
    detail: row.detail,
  };
}

export interface ClaimWebhookDeliveryInput {
  readonly webhookId: WebhookIdType;
  readonly dedupeKey: string;
  readonly receivedAt: string;
  readonly payloadBytes: number;
}

export interface ClaimedWebhookDelivery {
  readonly delivery: WebhookDeliverySummary;
  readonly webhook: WebhookDetail;
  readonly claimed: boolean;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const changes = yield* PubSub.unbounded<WebhookStreamEvent>();
  const secretMutationLock = yield* Semaphore.make(1);

  const randomId = Effect.fn("WebhookService.randomId")(function* <A>(make: (value: string) => A) {
    return make(yield* crypto.randomUUIDv4);
  });

  const randomToken = crypto.randomBytes(32).pipe(
    Effect.map(Encoding.encodeBase64Url),
    Effect.mapError(() => storageError("Failed to generate a Webhook secret.")),
  );

  const hashToken = Effect.fn("WebhookService.hashToken")(function* (token: string) {
    const digest = yield* crypto
      .digest("SHA-256", textEncoder.encode(token))
      .pipe(Effect.mapError(() => storageError("Failed to hash a Webhook secret.")));
    return Encoding.encodeBase64Url(digest);
  });

  const getGlobalRevision = Effect.fn("WebhookService.getGlobalRevision")(function* () {
    const rows = yield* sql<{ readonly revision: number }>`
      SELECT revision FROM webhook_state WHERE singleton = 1
    `;
    return rows[0]?.revision ?? 0;
  });

  const bumpGlobalRevision = Effect.fn("WebhookService.bumpGlobalRevision")(function* () {
    const rows = yield* sql<{ readonly revision: number }>`
      UPDATE webhook_state
      SET revision = revision + 1
      WHERE singleton = 1
      RETURNING revision
    `;
    return rows[0]?.revision ?? 0;
  });

  const interruptedLaunches = yield* sql<{ readonly id: string }>`
    UPDATE webhook_deliveries
    SET status = 'failed',
        detail = COALESCE(detail, 'The environment stopped while this delivery was starting.')
    WHERE status = 'launching' AND thread_id IS NULL
    RETURNING delivery_id AS id
  `;
  if (interruptedLaunches.length > 0) yield* bumpGlobalRevision();

  const selectWebhookRows = (where: "all" | "one", id?: WebhookIdType) =>
    sql<{
      readonly id: string;
      readonly projectId: string;
      readonly name: string;
      readonly promptPrefix: string;
      readonly modelSelection: string;
      readonly runtimeMode: string;
      readonly interactionMode: string;
      readonly workspace: string;
      readonly secretHash: string;
      readonly enabled: number;
      readonly revision: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly deletedAt: string | null;
    }>`
      SELECT
        webhook_id AS "id",
        project_id AS "projectId",
        name,
        prompt_prefix AS "promptPrefix",
        model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        workspace_json AS "workspace",
        secret_hash AS "secretHash",
        enabled,
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM webhooks
      WHERE deleted_at IS NULL
        AND (${where === "all" ? null : (id ?? null)} IS NULL OR webhook_id = ${
          where === "all" ? null : (id ?? null)
        })
      ORDER BY created_at ASC, webhook_id ASC
    `;

  const decodeWebhookRows = Effect.fn("WebhookService.decodeWebhookRows")(function* (
    rows: ReadonlyArray<unknown>,
  ) {
    return yield* Effect.forEach(rows, (row) =>
      decodeWebhookDbRow(row).pipe(Effect.mapError(decodeError("Invalid Webhook row"))),
    );
  });

  const readToken = Effect.fn("WebhookService.readToken")(function* (id: WebhookIdType) {
    const stored = yield* secrets
      .get(secretName(id))
      .pipe(Effect.mapError(() => storageError("Failed to read the Webhook secret.")));
    if (Option.isNone(stored)) return yield* storageError("The Webhook secret is missing.");
    return textDecoder.decode(stored.value);
  });

  const toDetail = Effect.fn("WebhookService.toDetail")(function* (
    row: WebhookDbRow,
    suppliedToken?: string,
  ): Effect.fn.Return<WebhookDetail, WebhookRpcError> {
    const token = suppliedToken ?? (yield* readToken(row.id));
    return {
      id: row.id,
      projectId: row.projectId as WebhookDetail["projectId"],
      name: row.name,
      promptPrefix: row.promptPrefix,
      modelSelection: row.modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      workspace: row.workspace,
      endpointPath: endpointPath(row.id, token),
      enabled: row.enabled !== 0,
      revision: Math.max(1, row.revision),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });

  const getWebhook = Effect.fn("WebhookService.getWebhook")(function* (id: WebhookIdType) {
    const rows = yield* selectWebhookRows("one", id).pipe(
      Effect.mapError(() => storageError("Failed to load Webhook.")),
    );
    const row = (yield* decodeWebhookRows(rows))[0];
    if (!row)
      return yield* new WebhookRpcError({ code: "not-found", message: "Webhook not found." });
    return yield* toDetail(row);
  });

  const authorizeDelivery = Effect.fn("WebhookService.authorizeDelivery")(function* (
    id: WebhookIdType,
    token: string,
  ) {
    const rows = yield* selectWebhookRows("one", id).pipe(
      Effect.mapError(() => storageError("Failed to load Webhook.")),
    );
    const row = (yield* decodeWebhookRows(rows))[0];
    const suppliedHash = yield* hashToken(token);
    if (!row || row.enabled === 0 || !timingSafeEqualBase64Url(row.secretHash, suppliedHash)) {
      return yield* new WebhookRpcError({ code: "not-found", message: "Webhook not found." });
    }
    return yield* toDetail(row, token);
  });

  const selectDeliveryRows = (input: {
    readonly webhookId: WebhookIdType;
    readonly deliveryId?: WebhookDeliveryIdType;
    readonly dedupeKey?: string;
    readonly before?: string;
    readonly limit: number;
  }) =>
    sql<{
      readonly id: string;
      readonly webhookId: string;
      readonly threadId: string | null;
      readonly storedStatus: string;
      readonly receivedAt: string;
      readonly definitionRevision: number;
      readonly payloadBytes: number;
      readonly detail: string | null;
      readonly sessionStatus: string | null;
      readonly turnState: string | null;
      readonly pendingApprovalCount: number | null;
      readonly pendingUserInputCount: number | null;
      readonly threadDeletedAt: string | null;
    }>`
      SELECT
        deliveries.delivery_id AS "id",
        deliveries.webhook_id AS "webhookId",
        deliveries.thread_id AS "threadId",
        deliveries.status AS "storedStatus",
        deliveries.received_at AS "receivedAt",
        deliveries.definition_revision AS "definitionRevision",
        deliveries.payload_bytes AS "payloadBytes",
        COALESCE(deliveries.detail, sessions.last_error) AS detail,
        sessions.status AS "sessionStatus",
        turns.state AS "turnState",
        threads.pending_approval_count AS "pendingApprovalCount",
        threads.pending_user_input_count AS "pendingUserInputCount",
        threads.deleted_at AS "threadDeletedAt"
      FROM webhook_deliveries AS deliveries
      LEFT JOIN projection_threads AS threads ON threads.thread_id = deliveries.thread_id
      LEFT JOIN projection_thread_sessions AS sessions ON sessions.thread_id = deliveries.thread_id
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = deliveries.thread_id
       AND turns.turn_id = threads.latest_turn_id
      WHERE deliveries.webhook_id = ${input.webhookId}
        AND (${input.deliveryId ?? null} IS NULL OR deliveries.delivery_id = ${
          input.deliveryId ?? null
        })
        AND (${input.dedupeKey ?? null} IS NULL OR deliveries.dedupe_key = ${
          input.dedupeKey ?? null
        })
        AND (${input.before ?? null} IS NULL OR deliveries.received_at < ${input.before ?? null})
      ORDER BY deliveries.received_at DESC, deliveries.delivery_id DESC
      LIMIT ${input.limit}
    `;

  const decodeDeliveryRows = Effect.fn("WebhookService.decodeDeliveryRows")(function* (
    rows: ReadonlyArray<unknown>,
  ) {
    return yield* Effect.forEach(rows, (row) =>
      decodeWebhookDeliveryDbRow(row).pipe(
        Effect.mapError(decodeError("Invalid Webhook delivery row")),
        Effect.map(toDeliverySummary),
      ),
    );
  });

  const getDeliveriesPage = Effect.fn("WebhookService.getDeliveriesPage")(function* (
    input: WebhookDeliveriesPageInput,
  ): Effect.fn.Return<WebhookDeliveriesPage, WebhookRpcError> {
    yield* getWebhook(input.webhookId);
    const limit = input.limit ?? 25;
    const rows = yield* selectDeliveryRows({
      webhookId: input.webhookId,
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: limit + 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load Webhook deliveries.")));
    const deliveries = yield* decodeDeliveryRows(rows);
    return {
      deliveries: deliveries.slice(0, limit),
      nextCursor: deliveries.length > limit ? (deliveries[limit - 1]?.receivedAt ?? null) : null,
    };
  });

  const toSummary = Effect.fn("WebhookService.toSummary")(function* (
    detail: WebhookDetail,
  ): Effect.fn.Return<WebhookSummary, WebhookRpcError> {
    const page = yield* getDeliveriesPage({ webhookId: detail.id, limit: 1 });
    const { promptPrefix: _promptPrefix, ...definition } = detail;
    return { ...definition, lastDelivery: page.deliveries[0] ?? null };
  });

  const getSnapshot = Effect.fn("WebhookService.getSnapshot")(function* (): Effect.fn.Return<
    WebhookSnapshot,
    WebhookRpcError
  > {
    const [rows, revision] = yield* Effect.all([
      selectWebhookRows("all").pipe(
        Effect.mapError(() => storageError("Failed to load Webhooks.")),
      ),
      getGlobalRevision().pipe(
        Effect.mapError(() => storageError("Failed to load Webhook revision.")),
      ),
    ]);
    const decoded = yield* decodeWebhookRows(rows);
    const webhooks = yield* Effect.forEach(decoded, (row) =>
      toDetail(row).pipe(Effect.flatMap(toSummary)),
    );
    return { revision, webhooks };
  });

  const projectExists = Effect.fn("WebhookService.projectExists")(function* (projectId: string) {
    const rows = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(Effect.mapError(() => storageError("Failed to validate Webhook project.")));
    return rows.length > 0;
  });

  const validateWrite = Effect.fn("WebhookService.validateWrite")(function* (
    input: WebhookCreateInput | WebhookUpdateInput,
  ) {
    if (!(yield* projectExists(input.projectId))) {
      return yield* new WebhookRpcError({
        code: "invalid-configuration",
        message: "The selected project no longer exists in this environment.",
      });
    }
  });

  const publishWebhook = Effect.fn("WebhookService.publishWebhook")(function* (
    detail: WebhookDetail,
    revision: number,
  ) {
    yield* PubSub.publish(changes, {
      type: "webhook-upserted",
      revision,
      webhook: yield* toSummary(detail),
    });
  });

  const create = Effect.fn("WebhookService.create")(function* (
    input: WebhookCreateInput,
  ): Effect.fn.Return<WebhookDetail, WebhookRpcError> {
    yield* validateWrite(input);
    const id = yield* randomId(WebhookId.make).pipe(
      Effect.mapError(() => storageError("Failed to generate a Webhook id.")),
    );
    const token = yield* randomToken;
    const secretHash = yield* hashToken(token);
    const createdAt = yield* nowIso;
    yield* secrets
      .create(secretName(id), textEncoder.encode(token))
      .pipe(Effect.mapError(() => storageError("Failed to store the Webhook secret.")));
    const globalRevision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO webhooks (
              webhook_id, project_id, name, prompt_prefix, model_selection_json,
              runtime_mode, interaction_mode, workspace_json, secret_hash,
              enabled, revision, created_at, updated_at, deleted_at
            ) VALUES (
              ${id}, ${input.projectId}, ${input.name}, ${input.promptPrefix},
              ${JSON.stringify(input.modelSelection)}, ${input.runtimeMode},
              ${input.interactionMode}, ${JSON.stringify(input.workspace)}, ${secretHash},
              ${input.enabled ? 1 : 0}, 1, ${createdAt}, ${createdAt}, NULL
            )
          `;
          return yield* bumpGlobalRevision();
        }),
      )
      .pipe(
        Effect.mapError(() => storageError("Failed to create Webhook.")),
        Effect.catch((error) =>
          secrets.remove(secretName(id)).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
        ),
      );
    const detail = yield* getWebhook(id);
    yield* publishWebhook(detail, globalRevision);
    return detail;
  });

  const update = Effect.fn("WebhookService.update")(function* (
    input: WebhookUpdateInput,
  ): Effect.fn.Return<WebhookDetail, WebhookRpcError> {
    yield* validateWrite(input);
    const current = yield* getWebhook(input.id);
    if (current.revision !== input.expectedRevision) {
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere. Reload it before saving.",
      });
    }
    const updatedAt = yield* nowIso;
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            UPDATE webhooks
            SET project_id = ${input.projectId},
                name = ${input.name},
                prompt_prefix = ${input.promptPrefix},
                model_selection_json = ${JSON.stringify(input.modelSelection)},
                runtime_mode = ${input.runtimeMode},
                interaction_mode = ${input.interactionMode},
                workspace_json = ${JSON.stringify(input.workspace)},
                enabled = ${input.enabled ? 1 : 0},
                revision = revision + 1,
                updated_at = ${updatedAt}
            WHERE webhook_id = ${input.id}
              AND revision = ${input.expectedRevision}
              AND deleted_at IS NULL
            RETURNING webhook_id AS id
          `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to update Webhook.")));
    if (!result.changed) {
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere. Reload it before saving.",
      });
    }
    const detail = yield* getWebhook(input.id);
    yield* publishWebhook(detail, result.revision);
    return detail;
  });

  const setEnabled = Effect.fn("WebhookService.setEnabled")(function* (
    input: WebhookRevisionInput,
    enabled: boolean,
  ): Effect.fn.Return<WebhookDetail, WebhookRpcError> {
    const updatedAt = yield* nowIso;
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            UPDATE webhooks
            SET enabled = ${enabled ? 1 : 0},
                revision = revision + 1,
                updated_at = ${updatedAt}
            WHERE webhook_id = ${input.id}
              AND revision = ${input.expectedRevision}
              AND deleted_at IS NULL
            RETURNING webhook_id AS id
          `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to change Webhook state.")));
    if (!result.changed) {
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere. Reload it before continuing.",
      });
    }
    const detail = yield* getWebhook(input.id);
    yield* publishWebhook(detail, result.revision);
    return detail;
  });

  const rotateSecretUnlocked = Effect.fn("WebhookService.rotateSecretUnlocked")(function* (
    input: WebhookRevisionInput,
  ): Effect.fn.Return<WebhookDetail, WebhookRpcError> {
    const current = yield* getWebhook(input.id);
    if (current.revision !== input.expectedRevision) {
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere. Reload it before rotating its URL.",
      });
    }
    const previous = yield* readToken(input.id);
    const token = yield* randomToken;
    const secretHash = yield* hashToken(token);
    const updatedAt = yield* nowIso;
    yield* secrets
      .set(secretName(input.id), textEncoder.encode(token))
      .pipe(Effect.mapError(() => storageError("Failed to store the new Webhook secret.")));
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            UPDATE webhooks
            SET secret_hash = ${secretHash},
                revision = revision + 1,
                updated_at = ${updatedAt}
            WHERE webhook_id = ${input.id}
              AND revision = ${input.expectedRevision}
              AND deleted_at IS NULL
            RETURNING webhook_id AS id
          `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(
        Effect.mapError(() => storageError("Failed to rotate the Webhook URL.")),
        Effect.catch((error) =>
          secrets
            .set(secretName(input.id), textEncoder.encode(previous))
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
        ),
      );
    if (!result.changed) {
      yield* secrets.set(secretName(input.id), textEncoder.encode(previous)).pipe(Effect.ignore);
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere. Reload it before rotating its URL.",
      });
    }
    const detail = yield* getWebhook(input.id);
    yield* publishWebhook(detail, result.revision);
    return detail;
  });
  const rotateSecret = Effect.fn("WebhookService.rotateSecret")((input: WebhookRevisionInput) =>
    secretMutationLock.withPermits(1)(rotateSecretUnlocked(input)),
  );

  const remove = Effect.fn("WebhookService.delete")(function* (
    input: WebhookRevisionInput,
  ): Effect.fn.Return<{ readonly id: WebhookIdType }, WebhookRpcError> {
    const deletedAt = yield* nowIso;
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
            UPDATE webhooks
            SET enabled = 0,
                deleted_at = ${deletedAt},
                updated_at = ${deletedAt},
                revision = revision + 1
            WHERE webhook_id = ${input.id}
              AND revision = ${input.expectedRevision}
              AND deleted_at IS NULL
            RETURNING webhook_id AS id
          `;
          return {
            changed: rows.length > 0,
            revision: rows.length > 0 ? yield* bumpGlobalRevision() : -1,
          };
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to delete Webhook.")));
    if (!result.changed) {
      return yield* new WebhookRpcError({
        code: "conflict",
        message: "This Webhook changed elsewhere or no longer exists.",
      });
    }
    yield* secrets.remove(secretName(input.id)).pipe(Effect.ignore({ log: true }));
    yield* PubSub.publish(changes, {
      type: "webhook-removed",
      revision: result.revision,
      webhookId: input.id,
    });
    return { id: input.id };
  });

  const claimDelivery = Effect.fn("WebhookService.claimDelivery")(function* (
    input: ClaimWebhookDeliveryInput,
  ): Effect.fn.Return<ClaimedWebhookDelivery, WebhookRpcError> {
    const webhook = yield* getWebhook(input.webhookId);
    if (!webhook.enabled) {
      return yield* new WebhookRpcError({ code: "not-found", message: "Webhook not found." });
    }
    const freshDeliveryId = yield* randomId(WebhookDeliveryId.make).pipe(
      Effect.mapError(() => storageError("Failed to generate a Webhook delivery id.")),
    );
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Lock the definition so pausing and delivery claims have deterministic ordering.
          const locked = yield* sql<{ readonly id: string }>`
            UPDATE webhooks SET updated_at = updated_at
            WHERE webhook_id = ${input.webhookId} AND enabled = 1 AND deleted_at IS NULL
            RETURNING webhook_id AS id
          `;
          if (locked.length === 0) {
            return yield* new WebhookRpcError({
              code: "not-found",
              message: "Webhook not found.",
            });
          }
          const rows = yield* sql<{ readonly id: string }>`
            INSERT OR IGNORE INTO webhook_deliveries (
              delivery_id, webhook_id, thread_id, status, received_at,
              definition_revision, payload_bytes, detail, dedupe_key
            ) VALUES (
              ${freshDeliveryId}, ${input.webhookId}, NULL, 'launching', ${input.receivedAt},
              ${webhook.revision}, ${input.payloadBytes}, NULL, ${input.dedupeKey}
            )
            RETURNING delivery_id AS id
          `;
          if (rows.length > 0) {
            return {
              deliveryId: freshDeliveryId,
              claimed: true,
              revision: yield* bumpGlobalRevision(),
            };
          }
          const existing = yield* sql<{
            readonly id: string;
            readonly storedStatus: string;
            readonly threadId: string | null;
          }>`
            SELECT delivery_id AS id, status AS "storedStatus", thread_id AS "threadId"
            FROM webhook_deliveries
            WHERE webhook_id = ${input.webhookId} AND dedupe_key = ${input.dedupeKey}
            LIMIT 1
          `;
          const row = existing[0];
          if (!row) {
            return yield* storageError("Failed to load the existing Webhook delivery.");
          }
          if (row.storedStatus === "failed" && row.threadId === null) {
            yield* sql`
              UPDATE webhook_deliveries
              SET status = 'launching', detail = NULL, received_at = ${input.receivedAt},
                  payload_bytes = ${input.payloadBytes}, definition_revision = ${webhook.revision}
              WHERE delivery_id = ${row.id}
            `;
            return {
              deliveryId: WebhookDeliveryId.make(row.id),
              claimed: true,
              revision: yield* bumpGlobalRevision(),
            };
          }
          return {
            deliveryId: WebhookDeliveryId.make(row.id),
            claimed: false,
            revision: -1,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isWebhookRpcError(cause) ? cause : storageError("Failed to claim Webhook delivery."),
        ),
      );
    const rows = yield* selectDeliveryRows({
      webhookId: input.webhookId,
      deliveryId: result.deliveryId,
      limit: 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load claimed Webhook delivery.")));
    const delivery = (yield* decodeDeliveryRows(rows))[0];
    if (!delivery) return yield* storageError("Claimed Webhook delivery was not found.");
    if (result.revision >= 0) {
      yield* PubSub.publish(changes, {
        type: "delivery-upserted",
        revision: result.revision,
        delivery,
      });
    }
    return { delivery, webhook, claimed: result.claimed };
  });

  const updateDelivery = Effect.fn("WebhookService.updateDelivery")(function* (input: {
    readonly webhookId: WebhookIdType;
    readonly deliveryId: WebhookDeliveryIdType;
    readonly threadId?: WebhookDeliverySummary["threadId"];
    readonly failureDetail?: string;
  }) {
    const revision = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE webhook_deliveries
            SET status = ${input.failureDetail === undefined ? "running" : "failed"},
                thread_id = ${input.threadId ?? null},
                detail = ${input.failureDetail ?? null}
            WHERE delivery_id = ${input.deliveryId} AND webhook_id = ${input.webhookId}
          `;
          return yield* bumpGlobalRevision();
        }),
      )
      .pipe(Effect.mapError(() => storageError("Failed to update Webhook delivery.")));
    const rows = yield* selectDeliveryRows({
      webhookId: input.webhookId,
      deliveryId: input.deliveryId,
      limit: 1,
    }).pipe(Effect.mapError(() => storageError("Failed to load updated Webhook delivery.")));
    const delivery = (yield* decodeDeliveryRows(rows))[0];
    if (!delivery) return yield* storageError("Updated Webhook delivery was not found.");
    yield* PubSub.publish(changes, { type: "delivery-upserted", revision, delivery });
    return delivery;
  });

  const subscribe = Effect.fn("WebhookService.subscribe")(function* () {
    const subscription = yield* subscribeBeforeSnapshotWithoutMutex(
      changes,
      getSnapshot().pipe(
        Effect.map((snapshot): WebhookStreamEvent => ({ type: "snapshot", snapshot })),
      ),
    );
    return Stream.concat(Stream.make(subscription.latest), subscription.changes);
  });

  return {
    getSnapshot,
    subscribe,
    getDetail: (input: { readonly id: WebhookIdType }) => getWebhook(input.id),
    getDeliveriesPage,
    create,
    update,
    pause: (input: WebhookRevisionInput) => setEnabled(input, false),
    resume: (input: WebhookRevisionInput) => setEnabled(input, true),
    rotateSecret,
    delete: remove,
    authorizeDelivery,
    claimDelivery,
    linkDelivery: (input: {
      readonly webhookId: WebhookIdType;
      readonly deliveryId: WebhookDeliveryIdType;
      readonly threadId: WebhookDeliverySummary["threadId"];
    }) => updateDelivery(input),
    failDelivery: (input: {
      readonly webhookId: WebhookIdType;
      readonly deliveryId: WebhookDeliveryIdType;
      readonly detail: string;
    }) => updateDelivery({ ...input, failureDetail: input.detail }),
  };
});

export class WebhookService extends Context.Service<WebhookService, Effect.Success<typeof make>>()(
  "t3/webhook/WebhookService",
) {}

export const WebhookServiceLive = Layer.effect(WebhookService, make);
