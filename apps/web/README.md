# apps/web

Vite + React operator console for Sub Wave AI. Talks to `/api/v1` (same origin in production; Vite proxy in development).

```bash
pnpm install
pnpm dev:api      # terminal 1
pnpm --filter @subwave-ai/web dev   # terminal 2, http://127.0.0.1:5173
```

Production: `pnpm --filter @subwave-ai/web build` then the API serves `apps/web/dist` (or `SUBWAVE_WEB_DIST`).

```bash
pnpm --filter @subwave-ai/web test
pnpm --filter @subwave-ai/web typecheck
```

No live URLs, credentials, or model names are hard-coded. Ollama is not installed from this package.
