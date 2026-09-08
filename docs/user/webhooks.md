# Webhooks

Webhooks start a fresh agent thread from an HTTP `POST` request. Open **Settings → Automations → Webhooks** to create and manage them.

A webhook saves the project, prompt prefix, provider and model, access mode, interaction mode, and workspace choice. When a request arrives, T3 Code places the prompt prefix first and appends the request body in a clearly marked untrusted-data envelope. JSON and plain-text bodies are supported up to 512 KiB.

Each webhook has a secret URL. Anyone with that URL can start an agent thread with the webhook's configured access, so treat it like a credential. You can pause a webhook without losing its history, rotate the URL if it is exposed, or delete it. Rotating invalidates the old URL immediately.

The environment that owns the project must be running and reachable from the system sending the request. A URL available only on localhost or a private network cannot receive requests from a hosted service.

## Delivery and retries

Successful requests return HTTP `202`. Every accepted event gets a delivery-history entry linked to its thread.

Send an `X-T3-Delivery-ID` header containing the source system's stable event identifier. Repeated requests with the same identifier create only one thread, which makes provider retries safe. Without this header, every request is treated as a distinct delivery so matching error payloads are not accidentally dropped.

The prompt prefix is trusted configuration, but the request body is not. T3 Code explicitly tells the agent to use the body as diagnostic evidence and not to follow instructions found inside it.

## PostHog exception alerts

The new-webhook form starts with a PostHog error-investigation prompt. It tells the agent to use the `fenra-monorepos` PostHog skill, investigate the exception and related events, fix the root cause, and run focused verification.

In PostHog, create a real-time error-tracking alert with an HTTP webhook destination, copy the T3 Code secret URL into the destination, and send the exception event as JSON. Set `X-T3-Delivery-ID` to the PostHog event UUID so PostHog retries do not create duplicate threads. See [PostHog's error tracking alert guide](https://posthog.com/docs/error-tracking/alerts) for its current alert and destination options.
