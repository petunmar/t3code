import { WebhookId, WebhookRpcError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as WebhookRunner from "./WebhookRunner.ts";
import * as WebhookService from "./WebhookService.ts";

export const WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isWebhookRpcError = Schema.is(WebhookRpcError);

function response(body: Readonly<Record<string, unknown>>, status: number) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function mediaType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

export const normalizeWebhookBody = Effect.fn("normalizeWebhookBody")(function* (
  body: string,
  contentType: string,
) {
  if (contentType !== "application/json" && !contentType.endsWith("+json")) return body;
  yield* decodeJson(body);
  return body;
});

export const webhookRouteLayer = HttpRouter.add(
  "POST",
  "/api/webhooks/:webhookId/:token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const webhookId = params.webhookId;
    const token = params.token;
    if (!webhookId || !token) return response({ error: "Webhook not found." }, 404);

    const declaredLength = Number.parseInt(request.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > WEBHOOK_MAX_BODY_BYTES) {
      return response({ error: "Webhook body is too large." }, 413);
    }

    const bodyResult = yield* Effect.result(
      request.text.pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          FileSystem.Size(WEBHOOK_MAX_BODY_BYTES),
        ),
      ),
    );
    if (bodyResult._tag === "Failure") {
      return response({ error: "Webhook body is too large or could not be read." }, 413);
    }
    const rawBody = bodyResult.success;
    const payloadBytes = textEncoder.encode(rawBody).byteLength;
    if (payloadBytes > WEBHOOK_MAX_BODY_BYTES) {
      return response({ error: "Webhook body is too large." }, 413);
    }

    const contentType = mediaType(request.headers["content-type"]);
    const normalizedResult = yield* Effect.result(normalizeWebhookBody(rawBody, contentType));
    if (normalizedResult._tag === "Failure") {
      return response({ error: "Webhook body must contain valid JSON." }, 400);
    }

    const service = yield* WebhookService.WebhookService;
    const runner = yield* WebhookRunner.WebhookRunner;
    const crypto = yield* Crypto.Crypto;
    const deliveryHint = request.headers["x-t3-delivery-id"]?.trim();
    const dedupeDigest = yield* (
      deliveryHint && deliveryHint.length <= 512
        ? crypto.digest("SHA-256", textEncoder.encode(`delivery:${deliveryHint}`))
        : crypto.randomBytes(32)
    ).pipe(
      Effect.mapError(
        () =>
          new WebhookRpcError({
            code: "storage-error",
            message: "Failed to identify the Webhook delivery.",
          }),
      ),
    );
    const receivedAt = DateTime.formatIso(yield* DateTime.now);

    const deliveryResult = yield* Effect.result(
      Effect.gen(function* () {
        const webhook = yield* service.authorizeDelivery(WebhookId.make(webhookId), token);
        const claimed = yield* service.claimDelivery({
          webhookId: webhook.id,
          dedupeKey: Encoding.encodeBase64Url(dedupeDigest),
          receivedAt,
          payloadBytes,
        });
        const delivery = yield* runner.runDelivery({
          ...claimed,
          payload: normalizedResult.success,
          contentType,
        });
        return { delivery, duplicate: !claimed.claimed };
      }),
    );

    if (deliveryResult._tag === "Failure") {
      const error = deliveryResult.failure;
      if (isWebhookRpcError(error) && error.code === "not-found") {
        return response({ error: "Webhook not found." }, 404);
      }
      yield* Effect.logWarning("webhook delivery failed", {
        webhookId,
        cause: deliveryResult.failure,
      });
      return response({ error: "Webhook delivery failed." }, 500);
    }

    return response(
      {
        accepted: true,
        duplicate: deliveryResult.success.duplicate,
        deliveryId: deliveryResult.success.delivery.id,
        threadId: deliveryResult.success.delivery.threadId,
      },
      202,
    );
  }),
);
