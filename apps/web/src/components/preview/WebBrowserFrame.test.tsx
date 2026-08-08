import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WebBrowserFrame } from "./WebBrowserFrame";

describe("WebBrowserFrame", () => {
  it("renders the preview URL in a regular browser iframe", () => {
    const markup = renderToStaticMarkup(
      <WebBrowserFrame
        runtimeTabId="environment:thread:tab"
        url="https://example.com/dashboard?mode=test"
        generation={2}
      />,
    );

    expect(markup).toContain('src="https://example.com/dashboard?mode=test"');
    expect(markup).toContain('data-web-browser-preview="environment:thread:tab"');
    expect(markup).toContain('title="Browser preview: https://example.com/dashboard?mode=test"');
  });

  it("routes localhost through the server-side preview gateway", () => {
    const markup = renderToStaticMarkup(
      <WebBrowserFrame
        runtimeTabId="environment:thread:tab"
        url="http://localhost:5173/app?mode=test"
        generation={0}
      />,
    );

    expect(markup).toContain('src="/__t3code_preview/aHR0cDovL2xvY2FsaG9zdDo1MTcz/app?mode=test"');
  });
});
