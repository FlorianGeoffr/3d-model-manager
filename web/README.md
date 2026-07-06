# 3D Model Manager — web

React 19 + TypeScript + Vite frontend for the 3D Model Manager. Talks to the
FastAPI backend under `/api/...` (session-cookie auth) and renders the
processing pipeline's GLB output with React Three Fiber.

- **Routing/data**: TanStack Router + TanStack Query
- **UI**: Tailwind 4 + shadcn/Radix components, `lucide-react` icons
- **Viewer**: `@react-three/fiber` + `@react-three/drei`, rendering the
  meshopt-compressed GLB served by `GET /api/blobs/{hash}/glb`
- **Realtime**: job/event updates over `GET /api/events` (SSE)

## Development

```sh
npm install
npm run dev
```

Vite's dev server proxies `/api` to `http://localhost:8080` (see
`vite.config.ts`) — run the backend alongside it (`cd ../backend && uv run
uvicorn app.main:app --reload --port 8080`, plus Postgres/Redis/a Celery
worker; see the repo root README's "Development" section), or point it at a
running `docker compose` stack.

```sh
npm run build   # tsc -b + vite build, output to web/dist
npm run lint    # oxlint
npm run test    # vitest run
```

`web/dist` is what the Docker image copies into the api container and serves
as the SPA (see `docker/Dockerfile`, `app/static.py`).
