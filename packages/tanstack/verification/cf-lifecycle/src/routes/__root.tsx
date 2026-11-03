/// <reference types="vite/client" />
import { useEffect } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { initCollector } from "../../../../../collector/src/index";

// The browser collector, started on the client only (useEffect does not run during SSR). It posts to the
// first-party route in routes/idr.e.ts.
function IdrCollector() {
  useEffect(() => {
    const collector = initCollector({ endpoint: "/idr/e", allow: ["page_view", "cta_click", "scroll_50", "scroll_90"], consent: "not_required", spa: true });
    return () => collector.stop();
  }, []);
  return null;
}

export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: "utf-8" }, { title: "probe" }] }),
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body><IdrCollector /><Outlet /><Scripts /></body>
    </html>
  ),
});
