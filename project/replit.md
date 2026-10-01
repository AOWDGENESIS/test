# Replit MCP Workspace Bridge

Ein abgesicherter MCP-Server stellt einem externen AI-Agenten Werkzeuge für dieses Replit-Projekt bereit.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- MCP endpoint: `/api/mcp` — authenticated multi-project Streamable HTTP gateway
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/routes/mcp.ts` — authenticated Streamable-HTTP MCP endpoint
- `artifacts/api-server/src/mcp/server.ts` — MCP tool definitions and explicit approval policy
- `artifacts/api-server/src/mcp/project-registry.ts` — dynamically loaded project registry
- `artifacts/api-server/src/mcp/workspace.ts` — per-project path sandbox and file operations
- `artifacts/api-server/src/mcp/log-buffer.ts` — bounded, project-scoped MCP activity logs
- `config/mcp-projects.json` — project IDs and workspace roots; loaded without rebuilding
- `docs/mcp.md` — client setup and security notes

## Architecture decisions

- The MCP endpoint is stateless Streamable HTTP, so every request is independently handled and no in-memory session registry is required.
- Every workspace operation requires an explicit `projectId`; there is no default project selection and no cross-project file lookup.
- The project registry is reloaded on access, so adding an enabled project entry does not require rebuilding the MCP server.
- All file paths are relative to the selected project root; absolute paths, symlink escapes, credential files, and private-key files are blocked.
- Shell commands run with a scrubbed environment, a 120-second maximum timeout, bounded output, and explicit approval for deletion/publish/push/deploy patterns.
- MCP authentication uses the dedicated `MCP_AUTH_TOKEN`; `SESSION_SECRET` is not reused for external access.

## Product

Ein vertrauenswürdiger externer AI-Agent kann zuerst die konfigurierten Projekt-IDs abrufen und danach für ein ausdrücklich ausgewähltes Projekt Dateien auflisten, lesen und schreiben, Tests oder andere Shell-Befehle ausführen und die projektbezogenen MCP-Aktivitätslogs abrufen.

## User preferences

- Kommunikation mit dem Nutzer erfolgt auf Deutsch.

## Gotchas

- Der MCP-Token darf nicht in Dateien, Logs oder Client-Nachrichten eingecheckt werden.
- Der Token gewährt absichtlich weitreichenden Projektzugriff; die URL und der Token dürfen nur an einen vertrauenswürdigen externen Agenten gegeben werden.
- Weitere Projekte müssen in `config/mcp-projects.json` mit einer eindeutigen ID und einem im Gateway-Laufzeitkontext erreichbaren Workspace-Root eingetragen werden.
- Es gibt kein MCP-Löschtool; riskante Shell-Muster benötigen `allowDangerous=true` als explizite Freigabe.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `docs/mcp.md` for external-agent configuration
