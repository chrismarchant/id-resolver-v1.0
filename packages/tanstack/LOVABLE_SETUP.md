# Lovable setup prompt

Paste the prompt below into Lovable, with the placeholders replaced. **Do not paste the resolver token into the chat
or into any file**: add it only through Lovable's secrets/environment UI for server-side variables.

```
Add server-side visit reporting to this TanStack Start project. Keep it minimal and do not touch any route, component,
styling, head/meta, or analytics code.

1. Install the package: <PACKAGE_SOURCE>   (for example "@salescrusader/idr-tanstack" once published, or the tarball
   URL I give you). It has no dependencies.

2. Open src/start.ts. Keep every existing request middleware and add this one to the requestMiddleware array:

   import { createMiddleware } from "@tanstack/react-start";
   import { createIdrServerMiddleware } from "@salescrusader/idr-tanstack";

   const idr = createMiddleware().server(
     createIdrServerMiddleware(() => ({
       resolverUrl: process.env.IDR_RESOLVER_URL ?? "",
       token: process.env.IDR_RESOLVER_TOKEN ?? "",
       websiteId: process.env.IDR_WEBSITE_ID ?? "",
       trustPolicy: { mode: "cloudflare" },
     })),
   );

   If src/start.ts does not exist, create it with createStart(() => ({ requestMiddleware: [idr] })).

3. Add three SERVER-ONLY environment variables (no VITE_ prefix, never referenced from client code, never logged):
   IDR_RESOLVER_URL = <RESOLVER_URL>
   IDR_WEBSITE_ID   = <WEBSITE_ID>
   IDR_RESOLVER_TOKEN = (I will add this myself as a secret; leave it empty in code and do not ask me to paste it here)

4. Rules: no browser script, no cookie, no localStorage, no fetch from the browser, no change to any response header,
   no logging of IP addresses, headers or the token. Do not wrap or modify the value returned by next().

5. Run the build and confirm: pages render exactly as before, the production build succeeds, and
   "IDR_RESOLVER_TOKEN" and "@salescrusader/idr-tanstack" do not appear in any file under the client output
   (for example grep the built client assets). Report the diff.
```

The trust policy `cloudflare` is correct only while the site is reachable only through Cloudflare (the Lovable default).
If that is not true, choose another policy first: see "Choosing a trust policy" in `README.md`.
