"use client";

import { webPreviewGatewayUrl } from "./webPreviewGateway";

/**
 * Regular-browser fallback for the Electron preview webview.
 *
 * This intentionally exposes only capabilities the browser can provide
 * reliably. Sites may still refuse embedding through CSP or X-Frame-Options,
 * and an HTTPS T3 client cannot embed an HTTP target.
 */
export function WebBrowserFrame(props: {
  readonly runtimeTabId: string;
  readonly url: string;
  readonly generation: number;
}) {
  return (
    <iframe
      key={`${props.runtimeTabId}:${props.generation}:${props.url}`}
      src={webPreviewGatewayUrl(props.url)}
      title={`Browser preview: ${props.url}`}
      className="absolute inset-0 h-full w-full border-0 bg-white"
      referrerPolicy="no-referrer"
      allow="clipboard-read; clipboard-write; fullscreen"
      data-web-browser-preview={props.runtimeTabId}
    />
  );
}
