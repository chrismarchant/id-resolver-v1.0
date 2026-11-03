import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/m/$mode/$id")({ component: () => <main><h1>probe page</h1></main> });
