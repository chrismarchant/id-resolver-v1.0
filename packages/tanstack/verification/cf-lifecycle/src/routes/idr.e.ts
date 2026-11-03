import { createFileRoute } from "@tanstack/react-router";
import { createCollectorRoute } from "../../../../src/index";

// The first-party collector route, registered exactly as documented: createCollectorRoute is called inline inside
// `server.handlers`, so the client build strips it. Same fixed synthetic token as start.ts (public-repo allowlisted
// pattern); the bundle-safety test proves neither reaches client assets. Points at the harness's local sink.
export const Route = createFileRoute("/idr/e")({
  server: {
    handlers: {
      POST: createCollectorRoute({
        resolverUrl: "http://127.0.0.1:4599",
        allowInsecureHttp: true,
        token: "0123456789abcdef0123456789abcdef",
        websiteId: "probe-site",
        allow: ["page_view", "cta_click", "scroll_50", "scroll_90"],
        consent: "not_required",
        onDeliveryResult: (r) => {
          ((globalThis as any).__idrResults ??= []).push(JSON.stringify({ route: "collector", ...r }));
        },
      }),
    },
  },
});
