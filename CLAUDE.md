# Agent Protocol & Architectural Mandate

**Version:** 2.4.1
**Target Project:** git-mcp-server
**Last Updated:** 2025-10-11

This document defines the operational rules for contributing to this codebase. Follow it exactly.

> **Note on File Synchronization**: This file (`AGENTS.md`), along with `CLAUDE.md` and `.clinerules/AGENTS.md`, are hard-linked on the filesystem for tool compatibility (e.g., Cline does not work with symlinks). **Edit only the root `AGENTS.md`** – changes will automatically propagate to the other copies. DO NOT TOUCH THE OTHER TWO AGENTS.md & CLAUDE.md FILES.

---

## I. Core Principles (Non‑Negotiable)

1.  **The Logic Throws, The Handler Catches**
    - **Your Task (Logic):**
      - **Tools:** Implement pure, stateless business logic inside the `logic` function of a `ToolDefinition`.
      - **Resources:** Implement pure, stateless read logic inside the `logic` function of a `ResourceDefinition`.
      - **Do not add `try...catch` in these logic functions.**
    - **On Failure:** You must throw `new McpError(...)` with the appropriate `JsonRpcErrorCode` and context.
    - **Framework's Job (Handlers):**
      - **Tools** are wrapped by `createMcpToolHandler`, which creates the `RequestContext`, measures execution via `measureToolExecution`, formats the response, and is the only place that catches errors.
      - **Resources** are wrapped by `registerResource` (`resourceHandlerFactory`). The handler validates params, invokes logic, applies `responseFormatter` (defaulting to JSON), and catches errors.

2.  **Full‑Stack Observability**
    - **Tracing:** OpenTelemetry is preconfigured. Logs and errors are automatically correlated to traces.
    - **Performance:** `measureToolExecution` automatically records duration, success, payload sizes, and error codes for every tool call.
    - **No Manual Instrumentation:** Do not add custom spans in your logic. Use the provided utilities and structured logging. The framework handles the single wrapper span per tool invocation.

3.  **Structured, Traceable Operations**
    - Your logic functions will receive two context objects: `appContext` (for internal logging/tracing) and `sdkContext` (for SDK-level operations like Elicitation, Sampling, and Roots).
    - The `sdkContext` provides methods (like `elicitInput` and `createMessage`) for client interaction.
    - Pass the _same_ `appContext` through your internal call stack for continuity.
    - Use the global `logger` for all logging; include the `appContext` in every log call.

4.  **Decoupled Storage**
    - Never directly access persistence backends (`fs`, `supabase-js`, Worker KV/R2) from tool/resource logic.
    - **Default: Use the `StorageService`**, injected via DI, for simple key-value persistence.
    - **Advanced: Create domain-specific providers** when your data has rich structure beyond key-value storage (e.g., relational queries, complex filtering, recursive loading). See **When to Create Custom Providers** below.
    - The concrete storage provider is configured via environment variables and initialized at startup.
    - **Note for git-mcp-server:** This server uses `StorageService` primarily for session state (working directory persistence). Git operations execute directly via CLI.

5.  **Local ↔ Edge Runtime Parity**
    - All features must work with both local transports (`bun run dev:stdio`, `bun run dev:http`) and the Worker bundle (`bun run build:worker` + `bunx wrangler dev`/`deploy`).
    - Guard non-portable dependencies so the bundle stays edge-compatible.
    - Prefer runtime-agnostic abstractions (Hono + `@hono/mcp`, Fetch APIs) to keep Bun/Node on localhost identical to Cloudflare Workers.
    - **Note for git-mcp-server:** Git CLI operations are local-only and not compatible with edge deployment. Edge deployment should be considered experimental.

6.  **Use Elicitation for Missing Input**
    - If a tool requires a parameter that was not provided, use the `elicitInput` function from the `sdkContext`.
    - This allows the tool to interactively request the necessary information from the user instead of failing.
    - **Note for git-mcp-server:** Elicitation is available but not currently used in git tools. All required parameters are explicitly defined in schemas.

7.  **Graceful Degradation in Development**
    - When context values like `tenantId` are missing, default to permissive behavior instead of throwing errors.
    - **Pattern:** `const tenantId = appContext.tenantId || 'default-tenant';`
    - This aligns with the philosophy that auth/scope checks default to allowed when auth is disabled.
    - Production environments with auth enabled will provide real `tenantId` from JWT claims automatically.

---

## II. Architectural Overview & Directory Structure

Separation of concerns maps directly to the filesystem. Always place files in their designated locations.

| Directory                                   | Purpose & Guidance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/mcp-server/tools/definitions/`**     | **MCP Tool definitions.** Add new capabilities here as `[tool-name].tool.ts`. Follow the **Tool Development Workflow**.                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`src/mcp-server/resources/definitions/`** | **MCP Resource definitions.** Add data sources or contexts as `[resource-name].resource.ts`. Follow the **Resource Development Workflow**.                                                                                                                                                                                                                                                                                                                                                                                        |
| **`src/mcp-server/tools/utils/`**           | **Shared tool utilities,** including `ToolDefinition` and tool handler factory.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`src/mcp-server/resources/utils/`**       | **Shared resource utilities,** including `ResourceDefinition` and resource handler factory.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **`src/mcp-server/transports/`**            | **Transport implementations:**<br>- `http/` (Hono + `@hono/mcp` Streamable HTTP)<br>- `stdio/` (MCP spec stdio transport)<br>- `auth/` (strategies and helpers). HTTP mode can enforce JWT or OAuth. Stdio mode should not implement HTTP-based auth.                                                                                                                                                                                                                                                                             |
| **`src/services/`**                         | **External service integrations** following a consistent domain-driven pattern:<br>- Each service domain (e.g., `git/`, `llm/`, `speech/`) contains: `core/` (interfaces, orchestrators, factories), `providers/` (implementations), `types.ts`, and `index.ts`<br>- Use DI for all service dependencies. See **Service Development Pattern** below.<br>- **For git-mcp-server:** The `git/` service implements a provider-based architecture with CLI operations organized by domain (see **Git Service Architecture** section). |
| **`src/storage/`**                          | **Abstractions and provider implementations** (in-memory, filesystem, supabase, cloudflare-r2, cloudflare-kv).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`src/container/`**                        | **Dependency Injection (`tsyringe`).** Service registration and tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`src/utils/`**                            | **Global utilities.** Includes logging, performance, parsing, network, security, and telemetry. Note: The error handling module is located at `src/utils/internal/error-handler/`.                                                                                                                                                                                                                                                                                                                                                |
| **`tests/`**                                | **Unit/integration tests.** Mirrors `src/` for easy navigation and includes compliance suites.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## III. Architectural Philosophy: Pragmatic SOLID

- **Single Responsibility:** Group code that changes together.
- **Open/Closed:** Prefer extension via abstractions (interfaces, plugins/middleware).
- **Liskov Substitution:** Subtypes must be substitutable without surprises.
- **Interface Segregation:** Keep interfaces small and focused.
- **Dependency Inversion:** Depend on abstractions (DI-managed services).

**Complementary principles:**

- **KISS:** Favor simplicity.
- **YAGNI:** Don't build what you don't need yet.
- **Composition over Inheritance:** Prefer composable modules.

---

## IV. Tool Development Workflow

This is the only approved workflow for authoring or modifying tools.

#### Step 1 — File Location

- Place new tools in `src/mcp-server/tools/definitions/`.
- Name files `[tool-name].tool.ts`.
- Use existing template tools as reference (e.g., `template-echo-message.tool.ts`).
- **For git-mcp-server:** Git tools follow the naming pattern `git-[operation].tool.ts` (e.g., `git-commit.tool.ts`, `git-clone.tool.ts`).

#### Step 2 — Define the ToolDefinition

Export a single `const` named `[toolName]Tool` of type `ToolDefinition` with:

- `name`: Programmatic tool name (`snake_case` is recommended).
- `title` (optional): Human-readable title for UIs.
- `description`: Clear, LLM-facing description of what the tool does.
- `inputSchema`: A `z.object({ ... })`. **Every field must have a `.describe()`**.
- `outputSchema`: A `z.object({ ... })` describing the successful output structure.
- `logic`: An `async` function with the signature `(input, appContext, sdkContext) => Promise<Output>`. This function should contain pure business logic.
  - **No `try/catch` blocks**; throw `McpError` on failure.
  - **For dependencies, resolve them inside the logic function** using the global `container`. Do not use `@injectable` classes for tool logic. The framework is designed for stateless, function-based logic.
- `annotations` (optional): UI/behavior hints such as `readOnlyHint`, `openWorldHint`, and others (flexible dictionary).
- `responseFormatter` (optional): Map successful output to `ContentBlock[]` for the LLM to consume. **CRITICAL**: The LLM receives this formatted output, not the raw result. Include all data the LLM needs to answer questions. Balance human-readable summaries with complete structured data. If omitted, a default JSON string is used.

**Git Tool Naming Convention:**

```typescript
/**
 * Programmatic tool name (must be unique).
 * Naming convention for git-mcp-server: git_<operation>_<object>
 * - Use 'git_' prefix for all git operations
 * - Use lowercase snake_case
 * - Examples: 'git_commit', 'git_clone', 'git_status', 'git_branch'
 */
const TOOL_NAME = 'git_commit';
const TOOL_TITLE = 'Git Commit';
const TOOL_DESCRIPTION =
  'Create a new commit with staged changes in the repository.';
```

#### Step 2.5 — Apply Authorization (Mandatory for most tools)

- Wrap `logic` with `withToolAuth`.
- **Example:**
  ```ts
  import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
  // ...
  logic: withToolAuth(['tool:git:write'], yourToolLogic),
  ```

#### Step 3 — Register via Barrel Export

- Add your tool to `src/mcp-server/tools/definitions/index.ts` in `allToolDefinitions`.
- The DI container discovers and registers all tools from that array. No further registration is necessary.

---

### Response Formatter: JSON Output Pattern

**As of v2.4.1**, all tools should use the standardized `createJsonFormatter` utility for consistent, machine-readable JSON output.

#### Why JSON Formatting?

1. **Consistency & Machine Readability**: Structured JSON ensures LLMs can reliably parse tool output
2. **Verbosity Control**: Users can choose `minimal`, `standard`, or `full` detail levels
3. **Complete Context**: LLMs receive complete data needed to answer follow-up questions

#### Basic Usage Pattern

```typescript
import {
  createJsonFormatter,
  type VerbosityLevel,
} from '../utils/json-response-formatter.js';

// 1. Define a filter function for verbosity control
function filterGitStatusOutput(
  result: ToolOutput,
  level: VerbosityLevel,
): Partial<ToolOutput> {
  if (level === 'minimal') {
    return {
      success: result.success,
      branch: result.branch,
    };
  }

  if (level === 'standard') {
    return {
      success: result.success,
      branch: result.branch,
      staged: result.staged, // Complete array, not truncated
      unstaged: result.unstaged,
    };
  }

  return result; // Full - everything
}

// 2. Create the formatter
const responseFormatter = createJsonFormatter<ToolOutput>({
  filter: filterGitStatusOutput,
});

// 3. Use in tool definition
export const gitStatusTool: ToolDefinition<...> = {
  // ...
  responseFormatter,
};
```

#### Critical Rules for Filter Functions

**✅ DO:**

- Include or omit entire fields based on verbosity level
- Use `shouldInclude(level, 'standard')` for conditional field inclusion
- Return complete arrays when included (LLMs need full context)
- Omit fields entirely at lower verbosity levels if not needed

**❌ DON'T:**

- Truncate arrays (breaks LLM context understanding)
- Return summaries without structured data
- Assume LLM can access the raw output object

**Example - Field Inclusion Pattern:**

```typescript
import { shouldInclude } from '../utils/json-response-formatter.js';

function filterOutput(
  result: ToolOutput,
  level: VerbosityLevel,
): Partial<ToolOutput> {
  return {
    success: result.success,
    commitHash: result.commitHash,
    // Include complete files array only at standard or higher
    ...(shouldInclude(level, 'standard') && { files: result.files }),
    // Include detailed status only at full verbosity
    ...(shouldInclude(level, 'full') && {
      detailedStatus: result.detailedStatus,
    }),
  };
}
```

#### Advanced Features

The `createJsonFormatter` utility provides several helper functions:

- **`filterByVerbosity<T>()`** - Field-based filtering with field lists per level
- **`shouldInclude()`** - Conditional field inclusion helper
- **`mergeFilters<T>()`** - Compose multiple filter functions
- **`createFieldMapper<T, R>()`** - Transform/rename fields during filtering
- **`createConditionalFilter<T>()`** - Apply different filters based on data properties

See [`docs/updating-tool-responses.md`](docs/updating-tool-responses.md) for complete migration guide and advanced usage patterns.

#### When to Skip the Filter Function

If your tool doesn't need verbosity control, you can omit the filter entirely:

```typescript
// Simple tools - always return full output as JSON
const responseFormatter = createJsonFormatter<ToolOutput>();
```

This is appropriate for:

- Simple confirmation operations (init, fetch)
- Tools with minimal output data
- Operations where all data is always relevant

---

#### Example Tool Definition (Git-specific with Dependency Injection):

```ts
/**
 * @fileoverview Git status tool - shows working tree status.
 * @module
 */
import { z } from 'zod';

import { logger, type RequestContext } from '@/utils/index.js';
import { resolveWorkingDirectory } from '../utils/git-validators.js';
import type { SdkContext, ToolDefinition } from '../utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { PathSchema } from '../schemas/common.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { GitProviderFactory } from '@/services/git/core/GitProviderFactory.js';
import {
  createJsonFormatter,
  type VerbosityLevel,
} from '../utils/json-response-formatter.js';

const TOOL_NAME = 'git_status';
const TOOL_TITLE = 'Git Status';
const TOOL_DESCRIPTION =
  'Show the working tree status including staged, unstaged, and untracked files.';

const TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
};

const InputSchema = z.object({
  path: PathSchema, // Defaults to '.' (session working directory)
});

const OutputSchema = z.object({
  branch: z.string().describe('Current branch name.'),
  staged: z.array(z.string()).describe('Files staged for commit.'),
  unstaged: z.array(z.string()).describe('Files with unstaged changes.'),
  untracked: z.array(z.string()).describe('Untracked files.'),
});

type ToolInput = z.infer<typeof InputSchema>;
type ToolOutput = z.infer<typeof OutputSchema>;

// Pure business logic function
async function gitStatusLogic(
  input: ToolInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ToolOutput> {
  logger.debug('Executing git status', {
    ...appContext,
    toolInput: input,
  });

  // Resolve working directory and get git provider via DI
  const { container } = await import('tsyringe');
  const {
    StorageService: StorageServiceToken,
    GitProviderFactory: GitProviderFactoryToken,
  } = await import('@/container/tokens.js');

  const storage = container.resolve<StorageService>(StorageServiceToken);
  const factory = container.resolve<GitProviderFactory>(
    GitProviderFactoryToken,
  );
  const provider = await factory.getProvider();

  // Helper handles both '.' (session) and absolute paths
  const targetPath = await resolveWorkingDirectory(
    input.path,
    appContext,
    storage,
  );

  // Call provider's status method - it handles execution and parsing
  const result = await provider.status(
    { includeUntracked: true },
    {
      workingDirectory: targetPath,
      requestContext: appContext,
      tenantId: appContext.tenantId || 'default-tenant',
    },
  );

  // Map provider result to tool output
  return {
    branch: result.currentBranch || 'detached HEAD',
    staged: [
      ...(result.stagedChanges.added || []),
      ...(result.stagedChanges.modified || []),
      ...(result.stagedChanges.deleted || []),
    ],
    unstaged: [
      ...(result.unstagedChanges.modified || []),
      ...(result.unstagedChanges.deleted || []),
    ],
    untracked: result.untrackedFiles,
  };
}

// Filter function for verbosity control
function filterGitStatusOutput(
  result: ToolOutput,
  level: VerbosityLevel,
): Partial<ToolOutput> {
  if (level === 'minimal') {
    // Essential info only
    return {
      branch: result.branch,
      staged: result.staged,
      unstaged: result.unstaged,
      untracked: result.untracked,
    };
  }

  // Standard and full return everything
  // (This simple tool doesn't have additional detail levels)
  return result;
}

// Formatter using standardized JSON output
const responseFormatter = createJsonFormatter<ToolOutput>({
  filter: filterGitStatusOutput,
});

// The final tool definition
export const gitStatusTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: TOOL_ANNOTATIONS,
  logic: withToolAuth(['tool:git:read'], gitStatusLogic),
  responseFormatter,
};
```

---

#### Working Directory Resolution Pattern (Git-Specific)

**Location:** [`src/mcp-server/tools/utils/git-validators.ts`](src/mcp-server/tools/utils/git-validators.ts)

Git tools need to support both explicit paths and session-based working directories. The `resolveWorkingDirectory()` helper provides this functionality.

**Usage Pattern:**

```ts
import { resolveWorkingDirectory } from '../utils/git-validators.js';
import type { StorageService } from '@/storage/core/StorageService.js';
import type { GitProviderFactory } from '@/services/git/core/GitProviderFactory.js';

async function myGitToolLogic(
  input: ToolInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ToolOutput> {
  // 1. Resolve dependencies via DI
  const { container } = await import('tsyringe');
  const {
    StorageService: StorageServiceToken,
    GitProviderFactory: GitProviderFactoryToken,
  } = await import('@/container/tokens.js');

  const storage = container.resolve<StorageService>(StorageServiceToken);
  const factory = container.resolve<GitProviderFactory>(
    GitProviderFactoryToken,
  );
  const provider = await factory.getProvider();

  // 2. Resolve working directory (handles '.' and absolute paths)
  const targetPath = await resolveWorkingDirectory(
    input.path, // '.' or absolute path
    appContext, // Request context with optional tenantId
    storage, // StorageService instance
  );

  // 3. Use provider for git operations
  const result = await provider.status(
    { includeUntracked: true },
    {
      workingDirectory: targetPath,
      requestContext: appContext,
      tenantId: appContext.tenantId || 'default-tenant',
    },
  );

  // ... rest of logic
}
```

**How it Works:**

1. **Path is `'.'`:** Loads from `StorageService` using key `session:workingDir:{tenantId}`
   - Uses graceful degradation: `tenantId || 'default-tenant'`
   - Throws `ValidationError` if no session directory is set

2. **Path is absolute:** Uses the provided path directly

3. **Security:** Always sanitizes paths to prevent directory traversal attacks

**Storage Key Pattern:**

```
session:workingDir:{tenantId}
```

**Common Mistakes to Avoid:**

❌ **DON'T** try to create synchronous wrappers:

```ts
// BROKEN: Can't await in sync function
const getWorkingDirectory = () => {
  return storage.get(...); // Returns Promise, not string!
};
```

❌ **DON'T** resolve storage outside tool logic:

```ts
// WRONG: StorageService requires RequestContext with tenantId
const storage = container.resolve<StorageService>(StorageService);
// Can't pass context here - it doesn't exist yet!
```

✅ **DO** resolve DI inside async tool logic:

```ts
// CORRECT: Async resolution inside tool logic function
async function toolLogic(input, appContext, sdkContext) {
  const { container } = await import('tsyringe');
  const storage = container.resolve<StorageService>(StorageServiceToken);
  const path = await resolveWorkingDirectory(input.path, appContext, storage);
}
```

---

## V. Resource Development Workflow

Resources mirror the tool pattern with a declarative `ResourceDefinition`. Use existing resources as reference templates.

#### Step 1 — File Location

- Place new resources in `src/mcp-server/resources/definitions/`.
- Name files `[resource-name].resource.ts`.
- **For git-mcp-server:** The primary resource is `git-working-directory.resource.ts` which provides session context.

#### Step 2 — Define the ResourceDefinition

Export a single `const` of type `ResourceDefinition` with:

- `name`: Unique programmatic resource name.
- `title` (optional): Human-readable title for UIs.
- `description`: Clear, LLM-facing description of what the resource returns.
- `uriTemplate`: A template like `git://working-directory`.
- `paramsSchema`: A `z.object({ ... })` for template/route params. **Every field must have a `.describe()`**.
- `outputSchema` (optional): A `z.object({ ... })` describing output.
- `mimeType` (optional): Default mime type for the response.
- `examples` (optional): Helpful discovery samples.
- `annotations` (optional): UI/behavior hints (flexible dictionary).
- `list` (optional): Provides `ListResourcesResult` for discovery.
- `logic`: `(uri, params, context) => { ... }` pure read logic. No `try/catch` here. Throw `McpError` on failure.
- `responseFormatter` (optional): `(result, { uri, mimeType }) => contents` array. If omitted, a default JSON formatter is used.

**Important:**

- The handler validates params via Zod before invoking `logic`.
- The `responseFormatter` must return an array of content blocks (`ReadResourceResult['contents']`). The handler performs a shallow validation (each item must be an object with a `uri`).
- Resource logic can be `async`; the handler `await`s it.

#### Step 2.5 — Apply Authorization

- Wrap `logic` with `withResourceAuth`.
- **Example:**
  ```ts
  import { withResourceAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
  // ...
  logic: withResourceAuth(['resource:git:read'], yourResourceLogic),
  ```

#### Step 3 — Register via Barrel Export

- Add your resource to `src/mcp-server/resources/definitions/index.ts` in `allResourceDefinitions`.
- The DI container discovers and registers all resources from that array.

---

## VI. Service Development Pattern

All external service integrations (LLM providers, speech services, email, etc.) follow a consistent domain-driven architecture pattern.

**Note for git-mcp-server:** This server uses the service pattern for git operations through a provider-based architecture. Git operations are implemented via CLI provider with abstraction for future providers (isomorphic-git, API-based, etc.).

#### Standard Service Structure

Every service domain follows this organization:

```
src/services/<service-name>/
├── core/                          # Interfaces and abstractions
│   ├── I<Service>Provider.ts     # Provider interface contract
│   └── <Service>Service.ts       # (Optional) Multi-provider orchestrator
├── providers/                     # Concrete implementations
│   ├── <provider-name>.provider.ts
│   └── ...
├── types.ts                       # Domain-specific types and DTOs
└── index.ts                       # Barrel export (public API)
```

#### When to Use a Service Orchestrator

Create a `<Service>Service.ts` class in `core/` when you need:

- **Multi-provider orchestration** (e.g., Speech uses different providers for TTS vs STT)
- **Provider routing logic** (e.g., fallback chains, load balancing)
- **Capability aggregation** (e.g., combined health checks)
- **Cross-provider state management**
- **Complex business logic** with multi-step operations, state transformations, or conditional flows
- **Stateful operations** like session management, progress tracking, or eligibility evaluation

If your service uses a **single provider pattern**, skip the service class and inject the provider directly via DI.

**Decision Matrix:**

| Scenario                               | Pattern                          | Example                                          |
| -------------------------------------- | -------------------------------- | ------------------------------------------------ |
| Simple CRUD with key-value storage     | Use `StorageService` directly    | User preferences, session working directory      |
| Single external API integration        | Provider only (no service class) | Not used in git-mcp-server                       |
| Multiple providers for same capability | Service orchestrator + Factory   | Git operations (CLI, isomorphic-git planned)     |
| Domain operations with abstraction     | Provider pattern with interface  | `IGitProvider` → `CliGitProvider` implementation |

#### Provider Implementation Guidelines

1. **Interface compliance**: All providers implement `I<Service>Provider`
2. **DI-injectable**: Mark with `@injectable()` decorator
3. **Health checks**: Implement `healthCheck(): Promise<boolean>`
4. **Error handling**: Throw `McpError` for failures (no try/catch in provider logic)
5. **Naming convention**: `<provider-name>.provider.ts` (lowercase, kebab-case)

#### When to Create Custom Providers

Create a custom provider (instead of using `StorageService`) when:

- **Rich data structure:** Your domain has complex nested objects, relationships, or metadata
- **Query capabilities:** You need filtering, searching, or aggregation beyond key-value lookup
- **Recursive operations:** Loading hierarchical data structures (e.g., directory trees)
- **Format transformation:** Reading/writing specific file formats (JSON, CSV, YAML)
- **Domain-specific validation:** Type-safe loading with Zod schemas for your domain
- **Cross-entity operations:** Joining data from multiple sources

**For git-mcp-server:**

The server uses `StorageService` for simple session state (working directory persistence). Git repository data is accessed through a provider-based architecture.

```typescript
// ✅ StorageService is sufficient for git-mcp-server session state:
const tenantId = appContext.tenantId || 'default-tenant';
const workingDir = await storage.get(`session:workingDir:${tenantId}`);

// ✅ Git operations through provider pattern:
const factory = GitProviderFactory.getInstance();
const provider = await factory.getProvider();
const status = await provider.status(options, context);
```

**When to stick with StorageService:**

- Simple key-value data (session working directory, user preferences)
- Flat data structures without complex relationships
- Basic CRUD operations without specialized queries

---

### Tool Layer vs Service Layer: Git Operations (git-mcp-server specific)

**IMPORTANT:** Tools MUST use the GitProvider interface for all git operations. Direct git command execution is forbidden in the tool layer.

#### Architecture Boundary

```
┌─────────────────────────────────────────────────┐
│           Tool Layer (MCP Tools)                │
│  - Input validation (Zod schemas)               │
│  - Path resolution (session storage)            │
│  - Pure validators (no git execution)           │
│  - Output formatting for LLM                    │
│  - Uses: resolveWorkingDirectory()              │
│  Location: src/mcp-server/tools/                │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼ GitProvider interface
┌─────────────────────────────────────────────────┐
│          Service Layer (Git Provider)           │
│  - Git command execution                        │
│  - Git-specific validators                      │
│  - Output parsing                               │
│  - Error transformation                         │
│  - Uses: executeGitCommand()                    │
│  Location: src/services/git/                    │
└─────────────────────────────────────────────────┘
```

#### Validator Location Rules

| Validator Type                   | Location                                      | Reason                             |
| -------------------------------- | --------------------------------------------- | ---------------------------------- |
| **Path sanitization**            | Tool layer (`git-validators.ts`)              | Security, tool-specific            |
| **Session directory resolution** | Tool layer (`git-validators.ts`)              | Uses StorageService, tool-specific |
| **Protected branch checks**      | Tool layer (`git-validators.ts`)              | Pure logic, no git execution       |
| **File path validation**         | Tool layer (`git-validators.ts`)              | Security, no git execution         |
| **Commit message format**        | Tool layer (`git-validators.ts`)              | Pure validation, no git execution  |
| **Git repository validation**    | Service layer (`cli/utils/git-validators.ts`) | Executes `git rev-parse`           |
| **Branch existence check**       | Service layer (`cli/utils/git-validators.ts`) | Executes `git rev-parse --verify`  |
| **Clean working dir check**      | Service layer (`cli/utils/git-validators.ts`) | Executes `git status --porcelain`  |
| **Remote existence check**       | Service layer (`cli/utils/git-validators.ts`) | Executes `git remote get-url`      |

#### Execution Layer Consolidation

As of version 2.4.1, the tool layer **no longer contains git command execution logic**. The deprecated `git-helpers.ts` file has been removed.

**❌ OLD (deprecated):**

```typescript
// Tool layer directly executing git commands
import { execGitCommand } from '../utils/git-helpers.js';
const result = await execGitCommand('status', ['--porcelain'], {
  cwd,
  context,
});
```

**✅ NEW (required):**

```typescript
// Tools delegate to service layer via GitProvider
const factory = container.resolve<GitProviderFactory>(GitProviderFactoryToken);
const provider = await factory.getProvider();
const result = await provider.status(options, context);
```

**Benefits:**

- **Single execution path** - Easier to maintain, debug, and secure
- **Better abstraction** - Tools don't know if git is CLI, isomorphic, or API-based
- **Easier testing** - Mock `IGitProvider` interface instead of git commands
- **Consistent error handling** - All git errors mapped to `McpError` in one place

---

### Git Service Architecture (git-mcp-server specific)

The git service follows a **provider-based architecture** with clear separation between interface, implementations, and operations.

#### Architecture Layers

```
src/services/git/
├── core/                          # Abstractions and coordination
│   ├── IGitProvider.ts           # Provider interface (contract)
│   ├── BaseGitProvider.ts        # Shared provider functionality
│   └── GitProviderFactory.ts     # Provider selection and caching
├── providers/                     # Concrete implementations
│   ├── cli/                      # CLI-based provider (current)
│   │   ├── operations/           # Organized git operations
│   │   ├── utils/                # CLI-specific utilities
│   │   ├── CliGitProvider.ts     # Main provider class
│   │   └── index.ts
│   └── isomorphic/               # Isomorphic-git provider (planned)
│       ├── operations/
│       └── ...
├── types.ts                       # Shared git types and DTOs
└── index.ts                       # Public API barrel export
```

#### CLI Operations Organization

The CLI provider organizes git operations by **domain** for better maintainability:

```
src/services/git/providers/cli/operations/
├── core/                          # Repository fundamentals
│   ├── init.ts                   # Initialize repository
│   ├── clone.ts                  # Clone repository
│   ├── status.ts                 # Working tree status
│   └── clean.ts                  # Remove untracked files
├── staging/                       # Working tree → Index
│   ├── add.ts                    # Stage changes
│   └── reset.ts                  # Unstage/reset
├── commits/                       # Commit history
│   ├── commit.ts                 # Create commits
│   ├── log.ts                    # View history
│   ├── show.ts                   # Show objects
│   └── diff.ts                   # Show changes
├── branches/                      # Branch operations
│   ├── branch.ts                 # List/create/delete
│   ├── checkout.ts               # Switch branches
│   ├── merge.ts                  # Merge branches
│   ├── rebase.ts                 # Rebase branches
│   └── cherry-pick.ts            # Cherry-pick commits
├── remotes/                       # Remote operations
│   ├── remote.ts                 # Manage remotes
│   ├── fetch.ts                  # Download changes
│   ├── push.ts                   # Upload changes
│   └── pull.ts                   # Fetch + integrate
├── tags/                          # Tag operations
│   └── tag.ts                    # List/create/delete tags
├── stash/                         # Stash operations
│   └── stash.ts                  # Push/pop/apply/drop/clear
├── worktree/                      # Worktree operations
│   └── worktree.ts               # Add/list/remove worktrees
├── history/                       # History inspection
│   ├── blame.ts                  # Line-by-line authorship
│   └── reflog.ts                 # Reference logs
└── index.ts                       # Single barrel export (root only)
```

**Key Design Principles:**

1. **Logical Grouping**: Operations grouped by domain (core, staging, commits, remotes, etc.)
2. **Single Responsibility**: Each file handles exactly one operation (one function per file)
3. **Consistent Structure**: All categories use subdirectories, no mixed patterns
4. **Single Import Point**: All exports consolidated in root `index.ts` (no nested barrel files)
5. **Pure Functions**: Each operation is a stateless async function that throws `McpError` on failure

**Operation Function Signature:**

```typescript
export async function executeOperation(
  options: GitOperationOptions,
  context: GitOperationContext,
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
): Promise<GitOperationResult> {
  // Pure business logic - no try/catch
  // Throw McpError on failure
}
```

#### Provider Selection via Factory

The `GitProviderFactory` handles provider instantiation and selection:

```typescript
const factory = GitProviderFactory.getInstance();
const provider = await factory.getProvider({
  preferredType: GitProviderType.CLI,
  isServerless: false,
  requiredCapabilities: ['blame', 'reflog'],
});

// Provider is cached - subsequent calls return same instance
const status = await provider.status(options, context);
```

**Provider Types:**

- **CLI** (`GitProviderType.CLI`): Full feature set, local-only (default)
- **Isomorphic** (`GitProviderType.ISOMORPHIC`): Core features, edge-compatible (planned)
- **GitHub API** (`GitProviderType.GITHUB_API`): Cloud-based, GitHub-specific (future)
- **GitLab API** (`GitProviderType.GITLAB_API`): Cloud-based, GitLab-specific (future)

#### IGitProvider Interface

All providers must implement the `IGitProvider` interface, which defines:

- **Repository operations**: init, clone, status, clean
- **Commit operations**: add, commit, log, show, diff
- **Branch operations**: branch, checkout, merge, rebase, cherryPick
- **Remote operations**: remote, fetch, push, pull
- **Tag operations**: tag (list/create/delete)
- **Stash operations**: stash (push/pop/apply/drop/clear)
- **Worktree operations**: worktree (add/list/remove/move/prune)
- **Additional operations**: reset, blame, reflog

Each provider declares its **capabilities** through the `GitProviderCapabilities` interface, allowing consumers to check feature support before calling methods.

#### BaseGitProvider Utilities

The `BaseGitProvider` abstract class provides shared functionality:

- **Capability checking**: `checkCapability(capability)` throws if unsupported
- **Logging helpers**: `logOperationStart()`, `logOperationSuccess()`
- **Validation**: `validateWorkingDirectory()`, `createOperationContext()`
- **Error handling**: `extractErrorMessage()`, `isGitNotFoundError()`

---

## VII. Core Services & Utilities

#### DI-Managed Services (tokens in `src/container/tokens.ts`)

**Services Used in git-mcp-server:**

- **`StorageService`**
  - **Token:** `StorageService`
  - **Usage:** `@inject(StorageService) private storage: StorageService`
  - **Purpose:** Session state (working directory persistence)
  - **Note:** Requires `context.tenantId`; `StorageService` enforces presence and throws if missing.

- **`Logger`** (pino-backed singleton)
  - **Token:** `Logger`
  - **Usage (in injectable classes):** `@inject(Logger) private logger: typeof logger`
  - **Purpose:** Structured logging for all operations

- **`App Config`**
  - **Token:** `AppConfig`
  - **Usage:** `@inject(AppConfig) private config: typeof configModule`
  - **Purpose:** Access to validated environment configuration

- **`RateLimiter`**
  - **Token:** `RateLimiterService`
  - **Usage:** `@inject(RateLimiterService) private rateLimiter: RateLimiter`
  - **Purpose:** Optional rate limiting for HTTP transport

- **`CreateMcpServerInstance`** (factory function)
  - **Token:** `CreateMcpServerInstance`
  - **Usage:** Resolved by the `TransportManager` to create/configure the `McpServer`.

- **`TransportManager`**
  - **Token:** `TransportManagerToken`
  - **Usage:** `@inject(TransportManagerToken) private transportManager: TransportManager`
  - **Purpose:** Manages stdio/HTTP transport lifecycle

**Services NOT Used in git-mcp-server:**

The following services are available in the template but not used in this project:

- ❌ `ILlmProvider` (no LLM integration needed)
- ❌ `SupabaseAdminClient` (not used for git operations)
- ❌ Speech services (not needed)

#### Storage Providers (configured in `src/storage/core/storageFactory.ts`)

- Supported values (env `STORAGE_PROVIDER_TYPE`):
  - `in-memory` (default) - **Recommended for git-mcp-server**
  - `filesystem` (requires `STORAGE_FILESYSTEM_PATH`, Node only)
  - `supabase` (requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`)
  - `cloudflare-r2` (Worker-only)
  - `cloudflare-kv` (Worker-only)
- In serverless environments (Workers), non-Cloudflare providers are forced to `in-memory`.
- **Always use `StorageService` from DI to interact with storage.**

#### Directly Imported Utilities (for function-style logic)

- `logger` from `src/utils/index.js`
- `requestContextService` from `src/utils/index.js`
- `ErrorHandler.tryCatch` from `src/utils/index.js` (NOT in tool/resource logic; OK in services or setup code)
- `sanitization` from `src/utils/index.js` - **Critical for git-mcp-server to prevent path traversal**
- `fetchWithTimeout` from `src/utils/index.js` (for robust network calls with timeouts)
- `measureToolExecution` from `src/utils/index.js` (used by handlers)

#### Key Utilities (`src/utils/`)

The `src/utils/` directory contains a rich set of directly importable utilities for common tasks.

| Module            | Description & Key Exports (git-mcp-server specific)                                                                                                                                                                                                                                                                             |
| :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`parsing/`**    | Robust parsers for various data formats. <br>- `jsonParser`: For parsing git command JSON output. <br>- `yamlParser`: For Git config files. <br>- Not typically needed: `csvParser`, `xmlParser`, `pdfParser`.                                                                                                                  |
| **`security/`**   | Security utilities - **CRITICAL for git operations**. <br>- `sanitization`: **MANDATORY** for validating file paths and preventing directory traversal. <br>- `rateLimiter`: Optional DI-managed service for enforcing rate limits. <br>- `idGenerator`: For creating unique identifiers (request IDs, session IDs).            |
| **`network/`**    | Networking helpers (not typically used in git-mcp-server). <br>- `fetchWithTimeout`: Available if needed for remote git operations.                                                                                                                                                                                             |
| **`scheduling/`** | Task scheduling (not typically used in git-mcp-server). <br>- `scheduler`: Available but git operations are on-demand.                                                                                                                                                                                                          |
| **`internal/`**   | Core internal machinery. <br>- `logger`: The global Pino logger instance - **use for all logging**. <br>- `requestContextService`: AsyncLocalStorage-based context propagation. <br>- `ErrorHandler`: Centralized error handling. <br>- `performance`: Utilities for performance measurement, including `measureToolExecution`. |
| **`telemetry/`**  | OpenTelemetry instrumentation and tracing helpers.                                                                                                                                                                                                                                                                              |

---

## VIII. Authentication & Authorization

#### HTTP Transport (configurable)

- **Modes:** `MCP_AUTH_MODE` = `'none' | 'jwt' | 'oauth'`
- When not `'none'`, the HTTP `/mcp` endpoint requires a `Bearer` token:
  - **JWT mode** uses a local secret (`MCP_AUTH_SECRET_KEY`).
    - In production, the secret is required; startup fails otherwise.
    - In development without the secret, verification is bypassed for template usability and a dev-mode `AuthInfo` is provided using `DEV_MCP_CLIENT_ID` and `DEV_MCP_SCOPES` (or sane defaults).
  - **OAuth mode** verifies JSON Web Tokens via a remote JWKS:
    - Requires `OAUTH_ISSUER_URL` and `OAUTH_AUDIENCE`; optionally `OAUTH_JWKS_URI`.
- **Extracted claims:**
  - `clientId`: token claim `'cid'` or `'client_id'`
  - `scopes`: array claim `'scp'` or space-delimited string `'scope'`
  - `subject`: `'sub'` (optional)
  - `tenantId`: `'tid'` (optional; if present, it becomes `context.tenantId` via `requestContextService`)
- **Scope enforcement inside logic:**
  - **Always wrap tool/resource logic with `withToolAuth` or `withResourceAuth`.**
  - If no auth context exists (e.g., auth disabled), the scope check defaults to allowed for development usability.

**Recommended scopes for git-mcp-server:**

- `tool:git:read` - For read-only operations (status, log, diff, show)
- `tool:git:write` - For write operations (commit, push, tag, branch create)
- `resource:git:read` - For resource access (working directory)

#### STDIO Transport

- Follows MCP spec guidance: no HTTP-based auth flows over stdio.
- Authorization is expected to be handled by the host application controlling the process.

#### CORS and Endpoints

- CORS is enabled with allowed origins from `MCP_ALLOWED_ORIGINS` or `'*'` as fallback.
- `GET /healthz`: unprotected health endpoint.
- `GET /mcp`: unprotected endpoint returning server identity and config summary.
- `POST`/`OPTIONS` `/mcp`: JSON-RPC transport; protection enforced when auth mode is not `'none'`.

---

## IX. Transports & Server Lifecycle

#### `createMcpServerInstance` (`src/mcp-server/server.ts`)

- Initializes `RequestContext` global config.
- Creates `McpServer` with identity and capabilities (logging, `resources/tools listChanged`, **elicitation**, **sampling**, **prompts**, **roots**).
- Registers all capabilities via DI-managed registries.
- Returns a configured `McpServer`.

#### `TransportManager` (`src/mcp-server/transports/manager.ts`)

- Resolves the `CreateMcpServerInstance` factory to get a configured `McpServer`.
- Based on `MCP_TRANSPORT_TYPE`, it instantiates and manages the lifecycle of the appropriate transport (`http` or `stdio`).
- Handles graceful startup and shutdown of the active transport.

#### Worker (Edge)

- `worker.ts` adapts the same `McpServer` and Hono app to Cloudflare Workers.
- Sets a `serverless` flag to guide storage provider selection.
- Uses `requestContextService` and `logger` for structured, traceable startup.
- **Note for git-mcp-server:** Edge deployment is experimental. Git CLI operations require local filesystem access.

---

## X. Code Style, Validation, and Security

- **JSDoc:** Every file must start with `@fileoverview` and `@module`. Exported APIs must be documented.
- **Validation:** All inputs are validated via Zod schemas. Ensure every field in schemas has a `.describe()`.
- **Logging:** Always include `RequestContext`; use `logger.debug/info/notice/warning/error/crit/emerg` appropriately.
- **Error Handling:** Logic throws `McpError`; handlers catch and standardize. Use `ErrorHandler.tryCatch` in services/infrastructure (not in tool/resource logic).
- **Secrets:** Access secrets only through `src/config/index.ts`. Never hard-code credentials.
- **Rate Limiting:** Use DI-injected `RateLimiter` where needed.
- **Telemetry:** Instrumentation is auto-initialized when enabled. Avoid manual spans.

**Git-Specific Security Requirements:**

- **Path Sanitization:** ALL file paths and repository paths MUST be validated using `sanitization` utilities to prevent directory traversal attacks.
- **Command Injection Prevention:** Git command arguments must be validated and never constructed from unsanitized user input.
- **Working Directory Validation:** Verify working directory exists and is a valid git repository before operations.
- **Destructive Operation Protection:** Operations like `git reset --hard`, `git clean -fd` must require explicit confirmation flags.

---

## XI. Checks & Workflow Commands

Use scripts from `package.json`:

- `bun rebuild`: cleans and rebuilds; also clears logs. Run after dependency changes.
- `bun devcheck` or `bun run devcheck`: lint, format, typecheck, security. Use flags like `--no-fix`, `--no-lint`, `--no-audit` to tailor.
- `bun test`: run unit/integration tests.
- `bun run dev:stdio` / `bun run dev:http`: run server in development mode.
- `bun run start:stdio` / `bun run start:http`: run after build.
- `bun run build:worker`: build Cloudflare Worker bundle.

---

## XII. Configuration & Environment

- All configuration is validated via Zod in `src/config/index.ts`.
- Derives `serviceName` and `version` from `package.json` if not provided via env.
- **Key variables:**
  - **Transport:** `MCP_TRANSPORT_TYPE` (`'stdio'`|`'http'`), `MCP_HTTP_PORT/HOST/PATH`
  - **Auth:** `MCP_AUTH_MODE` (`'none'`|`'jwt'`|`'oauth'`), `MCP_AUTH_SECRET_KEY` (jwt), `OAUTH_*` (oauth)
  - **Storage:** `STORAGE_PROVIDER_TYPE` (`'in-memory'`|`'filesystem'`|`'supabase'`|`'cloudflare-r2'`|`'cloudflare-kv'`)
  - **Git-Specific:**
    - `GIT_BINARY` - Path to git binary (defaults to `'git'`). Supports absolute paths (e.g., `/opt/homebrew/bin/git`) and tilde expansion
    - `GIT_SIGN_COMMITS` (`'true'`|`'false'`) - Enable GPG/SSH commit signing
    - `GIT_WRAPUP_INSTRUCTIONS_PATH` - Path to custom workflow instructions markdown file
  - **Telemetry:** `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `OTEL_EXPORTER_OTLP_*`

---

## XIII. Local & Edge Targets

- **Local parity:** Ensure both stdio and HTTP transports run and behave identically for your feature.
- **Worker compatibility:** `bun run build:worker` and `wrangler dev --local` must succeed before merging.
- `wrangler.toml` should use a `compatibility_date` of `2025-09-01` or later and `nodejs_compat` enabled.
- **Git-specific limitation:** Git CLI operations require local filesystem access and are not compatible with edge deployment in their current form.

---

## XIV. Multi-Tenancy & Storage Context

### Storage Tenancy Requirements

**`StorageService` requires `context.tenantId`** and will throw `McpError` with `JsonRpcErrorCode.ConfigurationError` if it's missing.

### Automatic Tenancy (HTTP Transport with Auth)

When using HTTP transport with authentication enabled (`MCP_AUTH_MODE='jwt'` or `'oauth'`):

- The `tenantId` is automatically extracted from the JWT token claim `'tid'`
- It's propagated to `RequestContext` via `requestContextService.withAuthInfo()`
- All tool/resource invocations automatically receive the correct `tenantId`

### TenantID Handling in Tools

**For tools that use `StorageService` or other tenant-scoped services:**

Follow the graceful degradation pattern to support both development and production:

```typescript
async function myToolLogic(
  input: ToolInput,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<ToolOutput> {
  // ✅ Graceful degradation: default to 'default-tenant' in development
  const tenantId = appContext.tenantId || 'default-tenant';

  const service = container.resolve<MyService>(MyServiceToken);
  const result = await service.doSomething(input.param, tenantId);

  return result;
}
```

**Why this pattern?**

- **Development (STDIO/no auth):** Works out-of-the-box without configuration
- **Production (HTTP + auth):** Real `tenantId` from JWT automatically available
- **Aligns with template philosophy:** Permissive in development, strict in production

**Alternative - Explicit Tenant Check:**

```typescript
// ❌ Don't throw errors for missing tenantId - breaks development experience
if (!appContext.tenantId) {
  throw new McpError(JsonRpcErrorCode.InvalidRequest, 'Tenant ID required');
}

// ✅ Use default instead
const tenantId = appContext.tenantId || 'default-tenant';
```

**When to use explicit tenant checking:**

- Security-critical operations where you must verify tenant isolation
- Production-only tools that should never run in development mode
- Audit trails where the actual tenant must be logged

**Troubleshooting:**

- **Error:** `"Storage operation requires a tenantId in the request context"`
- **Cause:** Tool passed `undefined` to a service expecting `tenantId`
- **Solution:** Apply the graceful degradation pattern: `const tenantId = appContext.tenantId || 'default-tenant';`

---

## XV. Quick Checklist

Before completing your task, ensure you have:

- [ ] Implemented tool/resource logic in a `*.tool.ts` or `*.resource.ts` file.
- [ ] Kept `logic` functions pure (no `try...catch`).
- [ ] Thrown `McpError` for failures within logic.
- [ ] Applied authorization with `withToolAuth` or `withResourceAuth`.
- [ ] Used `logger` with `appContext` for all significant operations.
- [ ] Used `StorageService` (DI) for session persistence (working directory).
- [ ] **Validated all file paths** using `sanitization` utilities (git-specific).
- [ ] **Prevented command injection** by validating git command arguments (git-specific).
- [ ] Registered definitions in the corresponding `index.ts` barrel files (Tools, Resources).
- [ ] Added or updated tests (`bun test`).
- [ ] Ran `bun run devcheck` to ensure code quality.
- [ ] Smoke-tested local transports (`bun run dev:stdio`/`http`).
- [ ] Validated the Worker bundle (`bun run build:worker`) if applicable.

That's it. Follow these guidelines to ensure consistency, security, and maintainability across the git-mcp-server codebase.
