import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/landing/$slug")({ component: () => <main><h1>landing</h1></main> });
