# Agent Protocol & Architectural Mandate

**Version:** 2.4.1
**Target Project:** git-mcp-server
**Last Updated:** 2025-12-17

This document defines the operational rules for contributing to this codebase. Follow it exactly.

> **Note on File Synchronization**: This file (`AGENTS.md`), along with `CLAUDE.md` and `.clinerules/AGENTS.md`, are hard-linked on the filesystem for tool compatibility (e.g., Cline does not work with symlinks). **Edit only the root `AGENTS.md`** – changes will automatically propagate to the other copies. DO NOT TOUCH THE OTHER TWO AGENTS.md & CLAUDE.md FILES.

---

## I. Core Principles (Non‑Negotiable)

1. **The Logic Throws, The Handler Catches**
   - **Tools/Resources**: Implement pure, stateless business logic in the `logic` function. **No `try...catch` blocks.**
   - **On Failure**: Throw `new McpError(...)` with appropriate `JsonRpcErrorCode` and context.
   - **Framework**: `createMcpToolHandler` and `registerResource` wrap logic, handle errors, and format responses.

2. **Full‑Stack Observability**
   - OpenTelemetry is preconfigured. Logs/errors are automatically correlated to traces.
   - `measureToolExecution` automatically records duration, success, payload sizes, and error codes.
   - **No manual instrumentation** - use provided utilities and structured logging.

3. **Structured, Traceable Operations**
   - Logic functions receive `appContext` (logging/tracing) and `sdkContext` (SDK operations).
   - Pass the same `appContext` through your call stack for continuity.
   - Use global `logger` for all logging; include `appContext` in every log call.

4. **Decoupled Storage**
   - Never directly access persistence backends from tool/resource logic.
   - **Default**: Use `StorageService` (DI-injected) for key-value persistence.
   - **Advanced**: Create domain-specific providers for rich data structures, queries, or format transformations.
   - **git-mcp-server**: Uses `StorageService` for session state (working directory). Git operations via provider pattern.

5. **Local ↔ Edge Runtime Parity**
   - All features work with both local transports and Worker bundle.
   - Guard non-portable dependencies for edge compatibility.
   - **git-mcp-server**: Git CLI operations are local-only. Edge deployment is experimental.

6. **Use Elicitation for Missing Input**
   - Use `elicitInput` from `sdkContext` to interactively request missing parameters.
   - **git-mcp-server**: Available but not currently used; all parameters are explicitly defined.

7. **Graceful Degradation in Development**
   - Default to permissive behavior when context values are missing.
   - **Pattern**: `const tenantId = appContext.tenantId || 'default-tenant';`
   - Production environments with auth provide real `tenantId` from JWT automatically.

---

## II. Architectural Overview

### Directory Structure

| Directory                                   | Purpose                                                                                                                              |
| :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| **`src/mcp-server/tools/definitions/`**     | MCP Tool definitions as `[tool-name].tool.ts`. Follow **Tool Development Workflow**.                                                 |
| **`src/mcp-server/resources/definitions/`** | MCP Resource definitions as `[resource-name].resource.ts`. Follow **Resource Development Workflow**.                                 |
| **`src/mcp-server/tools/utils/`**           | Shared tool utilities, including `ToolDefinition` and tool handler factory.                                                          |
| **`src/mcp-server/resources/utils/`**       | Shared resource utilities, including `ResourceDefinition` and resource handler factory.                                              |
| **`src/mcp-server/transports/`**            | Transport implementations: `http/` (Hono + `@hono/mcp`), `stdio/` (MCP spec), `auth/` (strategies).                                 |
| **`src/services/`**                         | External service integrations. Each domain contains: `core/`, `providers/`, `types.ts`, `index.ts`. See **Git Service Architecture**. |
| **`src/storage/`**                          | Storage abstractions and provider implementations.                                                                                   |
| **`src/container/`**                        | Dependency Injection (`tsyringe`). Service registration and tokens.                                                                  |
| **`src/utils/`**                            | Global utilities: logging, performance, parsing, network, security, telemetry.                                                       |
| **`tests/`**                                | Unit/integration tests mirroring `src/` structure.                                                                                   |

### Architectural Philosophy

- **SOLID Principles**: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.
- **Complementary**: KISS (simplicity), YAGNI (don't over-engineer), Composition over Inheritance.

---

## III. Tool Development Workflow

**File Location**: `src/mcp-server/tools/definitions/[tool-name].tool.ts`

**Git naming pattern**: `git-[operation].tool.ts` (e.g., `git-commit.tool.ts`)

### Step 1 — Define ToolDefinition

Export a single `const` of type `ToolDefinition` with:

- `name`: Programmatic tool name (`snake_case`). Git tools: `git_<operation>` (e.g., `git_commit`)
- `title` (optional): Human-readable title for UIs
- `description`: Clear, LLM-facing description
- `inputSchema`: `z.object({ ... })` with `.describe()` on every field
- `outputSchema`: `z.object({ ... })` describing successful output
- `logic`: `async (input, appContext, sdkContext) => Promise<Output>`
  - Pure business logic. **No `try/catch`**. Throw `McpError` on failure.
  - **Resolve dependencies inside logic** using global `container`.
- `annotations` (optional): UI/behavior hints (`readOnlyHint`, etc.)
- `responseFormatter` (optional): Map output to `ContentBlock[]`. **Critical**: LLM receives formatted output, not raw result.

**See**: [Tool Development Guide](docs/tool-development-guide.md) for complete example with Git-specific patterns.

### Step 2 — Apply Authorization

Wrap `logic` with `withToolAuth`:

```typescript
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';

logic: withToolAuth(['tool:git:write'], yourToolLogic),
```

### Step 3 — Register Tool

Add to `src/mcp-server/tools/definitions/index.ts` in `allToolDefinitions` array.

### Response Formatting

**As of v2.4.1**, use `createJsonFormatter` for consistent JSON output:

```typescript
import { createJsonFormatter } from '../utils/json-response-formatter.js';

const responseFormatter = createJsonFormatter<ToolOutput>({
  filter: filterFunction, // Optional - for verbosity control
});
```

**See**: [Response Formatting Guide](docs/response-formatting.md) for detailed patterns.

### Working Directory Resolution (Git-Specific)

Use `resolveWorkingDirectory()` helper for session-based and explicit paths:

```typescript
const targetPath = await resolveWorkingDirectory(
  input.path,    // '.' or absolute path
  appContext,    // Request context
  storage,       // StorageService instance
);
```

**See**: [Tool Development Guide](docs/tool-development-guide.md#working-directory-resolution-pattern)

---

## IV. Resource Development Workflow

**File Location**: `src/mcp-server/resources/definitions/[resource-name].resource.ts`

### Define ResourceDefinition

Export a single `const` of type `ResourceDefinition` with:

- `name`: Unique programmatic name
- `uriTemplate`: Template like `git://working-directory`
- `paramsSchema`: `z.object({ ... })` with `.describe()` on every field
- `outputSchema` (optional): `z.object({ ... })` describing output
- `logic`: `(uri, params, context) => { ... }` - pure read logic, no `try/catch`
- `responseFormatter` (optional): `(result, { uri, mimeType }) => contents[]`
- `list` (optional): Provides `ListResourcesResult` for discovery

### Apply Authorization

```typescript
import { withResourceAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';

logic: withResourceAuth(['resource:git:read'], yourResourceLogic),
```

### Register Resource

Add to `src/mcp-server/resources/definitions/index.ts` in `allResourceDefinitions` array.

---

## V. Service Development Pattern

### Standard Service Structure

```
src/services/<service-name>/
├── core/                          # Interfaces and abstractions
│   ├── I<Service>Provider.ts     # Provider interface contract
│   └── <Service>Service.ts       # (Optional) Multi-provider orchestrator
├── providers/                     # Concrete implementations
├── types.ts                       # Domain-specific types
└── index.ts                       # Barrel export
```

### When to Use Service Orchestrator

Create `<Service>Service.ts` when you need:

- Multi-provider orchestration (fallback chains, routing)
- Capability aggregation or cross-provider state
- Complex multi-step business logic

Otherwise, inject provider directly via DI.

### Provider Guidelines

1. Implement `I<Service>Provider` interface
2. Mark with `@injectable()` decorator
3. Implement `healthCheck(): Promise<boolean>`
4. Throw `McpError` for failures (no try/catch in logic)
5. Naming: `<provider-name>.provider.ts` (kebab-case)

### Git Service Architecture

**git-mcp-server** uses provider-based architecture with CLI operations organized by domain (core, staging, commits, branches, remotes, tags, stash, worktree, history).

**See**: [Git Service Architecture](docs/git-service-architecture.md) for complete details.

**Key Pattern**: Tools MUST use `GitProvider` interface. Direct git command execution is forbidden in tool layer.

```typescript
// ✅ Correct
const factory = container.resolve<GitProviderFactory>(GitProviderFactoryToken);
const provider = await factory.getProvider();
const result = await provider.status(options, context);
```

---

## VI. Core Services & Utilities

### DI-Managed Services (git-mcp-server)

- **`StorageService`**: Session state (working directory persistence). Requires `context.tenantId`.
- **`Logger`**: Pino-backed structured logging.
- **`AppConfig`**: Validated environment configuration.
- **`RateLimiter`**: Optional rate limiting for HTTP transport.
- **`GitProviderFactory`**: Git provider selection and caching.

### Storage Providers

Configure via `STORAGE_PROVIDER_TYPE`:

- `in-memory` (default, recommended for git-mcp-server)
- `filesystem`, `supabase`, `cloudflare-r2`, `cloudflare-kv`

Always use `StorageService` from DI.

### Key Utilities (`src/utils/`)

- **`parsing/`**: `jsonParser`, `yamlParser` for git command output and config files
- **`security/`**: `sanitization` (**MANDATORY** for path validation), `rateLimiter`, `idGenerator`
- **`internal/`**: `logger`, `requestContextService`, `ErrorHandler`, `measureToolExecution`
- **`telemetry/`**: OpenTelemetry instrumentation helpers

**Critical for git**: ALL file paths MUST be validated using `sanitization` utilities to prevent directory traversal.

---

## VII. Authentication & Authorization

### HTTP Transport

**Modes**: `MCP_AUTH_MODE` = `'none' | 'jwt' | 'oauth'`

- **JWT mode**: Uses `MCP_AUTH_SECRET_KEY`. Dev mode bypasses if secret missing.
- **OAuth mode**: Verifies JWT via remote JWKS. Requires `OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE`.
- **Extracted claims**: `clientId`, `scopes`, `subject`, `tenantId` (→ `context.tenantId`)

**Scope enforcement**: Always wrap logic with `withToolAuth` or `withResourceAuth`. Defaults to allowed when auth disabled.

**Recommended scopes**:

- `tool:git:read` - Read-only operations (status, log, diff, show)
- `tool:git:write` - Write operations (commit, push, tag, branch create)
- `resource:git:read` - Resource access (working directory)

### STDIO Transport

No HTTP-based auth. Authorization handled by host application.

---

## VIII. Configuration & Environment

All configuration validated via Zod in `src/config/index.ts`.

**Key variables**:

- **Transport**: `MCP_TRANSPORT_TYPE` (`'stdio'`|`'http'`), `MCP_HTTP_PORT/HOST/PATH`
- **Auth**: `MCP_AUTH_MODE`, `MCP_AUTH_SECRET_KEY`, `OAUTH_*`
- **Storage**: `STORAGE_PROVIDER_TYPE`
- **Git-Specific**:
  - `GIT_BINARY` - Path to git binary (default: `'git'`). Supports absolute paths and tilde expansion.
  - `GIT_SIGN_COMMITS` (`'true'`|`'false'`) - Enable GPG/SSH commit signing
  - `GIT_WRAPUP_INSTRUCTIONS_PATH` - Custom workflow instructions markdown file
- **Telemetry**: `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_*`

---

## IX. Multi-Tenancy & Storage Context

### Storage Tenancy

`StorageService` requires `context.tenantId`. Throws `McpError` if missing.

### Automatic Tenancy (HTTP + Auth)

With `MCP_AUTH_MODE='jwt'` or `'oauth'`:

- `tenantId` extracted from JWT claim `'tid'`
- Propagated to `RequestContext` via `requestContextService`
- All tool/resource invocations receive correct `tenantId`

### Graceful Degradation Pattern

```typescript
// ✅ Use default in development
const tenantId = appContext.tenantId || 'default-tenant';
```

**Why**: Works out-of-box in development; uses real `tenantId` in production.

**When to be strict**: Security-critical operations, production-only tools, audit trails.

---

## X. Code Style & Security

- **JSDoc**: Every file starts with `@fileoverview` and `@module`. Document exported APIs.
- **Validation**: All inputs validated via Zod schemas. Every field has `.describe()`.
- **Logging**: Always include `RequestContext`. Use appropriate log levels.
- **Error Handling**: Logic throws `McpError`; handlers catch and standardize.
- **Secrets**: Access only through `src/config/index.ts`. Never hard-code.
- **Telemetry**: Auto-initialized when enabled. Avoid manual spans.

### Git-Specific Security

- **Path Sanitization**: ALL paths MUST be validated using `sanitization` utilities
- **Command Injection Prevention**: Validate git command arguments; never construct from unsanitized input
- **Working Directory Validation**: Verify directory exists and is valid git repository
- **Destructive Operation Protection**: Operations like `git reset --hard`, `git clean -fd` require explicit confirmation flags

---

## XI. Workflow Commands

- `bun rebuild`: Clean, rebuild, clear logs. Run after dependency changes.
- `bun devcheck`: Lint, format, typecheck, security. Use `--no-fix`, `--no-lint`, `--no-audit` to tailor.
- `bun test`: Run unit/integration tests.
- `bun run dev:stdio` / `dev:http`: Development mode.
- `bun run start:stdio` / `start:http`: Production mode (after build).
- `bun run build:worker`: Build Cloudflare Worker bundle.

---

## XII. Quick Checklist

Before completing your task:

- [ ] Implemented tool/resource logic in `*.tool.ts` or `*.resource.ts`
- [ ] Kept `logic` functions pure (no `try...catch`)
- [ ] Threw `McpError` for failures
- [ ] Applied `withToolAuth` or `withResourceAuth`
- [ ] Used `logger` with `appContext`
- [ ] Used `StorageService` (DI) for session persistence
- [ ] **Validated all file paths** using `sanitization` utilities
- [ ] **Prevented command injection** by validating git arguments
- [ ] Registered in corresponding `index.ts` barrel files
- [ ] Added/updated tests (`bun test`)
- [ ] Ran `bun run devcheck`
- [ ] Smoke-tested local transports
- [ ] Validated Worker bundle if applicable

---

## Additional Resources

- [Tool Development Guide](docs/tool-development-guide.md) - Complete examples and patterns
- [Response Formatting Guide](docs/response-formatting.md) - Detailed response formatter patterns
- [Git Service Architecture](docs/git-service-architecture.md) - Provider-based architecture details

---

That's it. Follow these guidelines to ensure consistency, security, and maintainability across the git-mcp-server codebase.
