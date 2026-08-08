const PREVIEW_GATEWAY_PREFIX = "/__t3code_preview";

const encodeOrigin = (origin: string): string =>
  btoa(origin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export function webPreviewGatewayUrl(rawUrl: string): string {
  const target = new URL(rawUrl);
  const hostname = target.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    return rawUrl;
  }
  return `${PREVIEW_GATEWAY_PREFIX}/${encodeOrigin(target.origin)}${target.pathname}${target.search}${target.hash}`;
}
