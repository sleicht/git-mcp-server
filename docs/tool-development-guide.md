# Tool Development Guide

**Version:** 2.4.1
**Last Updated:** 2025-10-11

This guide provides detailed examples and patterns for developing MCP tools in git-mcp-server.

## Complete Tool Example

Here's a complete git tool implementation showing all essential patterns:

```typescript
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
    return {
      branch: result.branch,
      staged: result.staged,
      unstaged: result.unstaged,
      untracked: result.untracked,
    };
  }

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

## Working Directory Resolution Pattern

**Location:** [`src/mcp-server/tools/utils/git-validators.ts`](../src/mcp-server/tools/utils/git-validators.ts)

Git tools support both explicit paths and session-based working directories through the `resolveWorkingDirectory()` helper.

### Usage Pattern

```typescript
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

### How It Works

1. **Path is `'.'`:** Loads from `StorageService` using key `session:workingDir:{tenantId}`
   - Uses graceful degradation: `tenantId || 'default-tenant'`
   - Throws `ValidationError` if no session directory is set

2. **Path is absolute:** Uses the provided path directly

3. **Security:** Always sanitizes paths to prevent directory traversal attacks

### Storage Key Pattern

```
session:workingDir:{tenantId}
```

### Common Mistakes to Avoid

#### ❌ DON'T try to create synchronous wrappers

```typescript
// BROKEN: Can't await in sync function
const getWorkingDirectory = () => {
  return storage.get(...); // Returns Promise, not string!
};
```

#### ❌ DON'T resolve storage outside tool logic

```typescript
// WRONG: StorageService requires RequestContext with tenantId
const storage = container.resolve<StorageService>(StorageService);
// Can't pass context here - it doesn't exist yet!
```

#### ✅ DO resolve DI inside async tool logic

```typescript
// CORRECT: Async resolution inside tool logic function
async function toolLogic(input, appContext, sdkContext) {
  const { container } = await import('tsyringe');
  const storage = container.resolve<StorageService>(StorageServiceToken);
  const path = await resolveWorkingDirectory(input.path, appContext, storage);
}
```

## Git Tool Naming Convention

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

## See Also

- [Response Formatting Guide](./response-formatting.md) - Detailed response formatter patterns
- [Git Service Architecture](./git-service-architecture.md) - Provider-based architecture
- [`src/mcp-server/tools/definitions/`](../src/mcp-server/tools/definitions/) - Tool examples
