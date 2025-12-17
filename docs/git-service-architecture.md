# Git Service Architecture

**Version:** 2.4.1
**Last Updated:** 2025-10-11

This document describes the provider-based architecture used for git operations in git-mcp-server.

## Overview

The git service follows a **provider-based architecture** with clear separation between interface, implementations, and operations.

## Architecture Layers

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

## CLI Operations Organization

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

### Key Design Principles

1. **Logical Grouping**: Operations grouped by domain (core, staging, commits, remotes, etc.)
2. **Single Responsibility**: Each file handles exactly one operation (one function per file)
3. **Consistent Structure**: All categories use subdirectories, no mixed patterns
4. **Single Import Point**: All exports consolidated in root `index.ts` (no nested barrel files)
5. **Pure Functions**: Each operation is a stateless async function that throws `McpError` on failure

### Operation Function Signature

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

## Provider Selection via Factory

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

### Provider Types

- **CLI** (`GitProviderType.CLI`): Full feature set, local-only (default)
- **Isomorphic** (`GitProviderType.ISOMORPHIC`): Core features, edge-compatible (planned)
- **GitHub API** (`GitProviderType.GITHUB_API`): Cloud-based, GitHub-specific (future)
- **GitLab API** (`GitProviderType.GITLAB_API`): Cloud-based, GitLab-specific (future)

## IGitProvider Interface

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

## BaseGitProvider Utilities

The `BaseGitProvider` abstract class provides shared functionality:

- **Capability checking**: `checkCapability(capability)` throws if unsupported
- **Logging helpers**: `logOperationStart()`, `logOperationSuccess()`
- **Validation**: `validateWorkingDirectory()`, `createOperationContext()`
- **Error handling**: `extractErrorMessage()`, `isGitNotFoundError()`

## Tool Layer vs Service Layer Boundary

**IMPORTANT:** Tools MUST use the GitProvider interface for all git operations. Direct git command execution is forbidden in the tool layer.

### Architecture Boundary

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

### Validator Location Rules

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

## Execution Layer Consolidation

As of version 2.4.1, the tool layer **no longer contains git command execution logic**.

### ❌ OLD (deprecated)

```typescript
// Tool layer directly executing git commands
import { execGitCommand } from '../utils/git-helpers.js';
const result = await execGitCommand('status', ['--porcelain'], {
  cwd,
  context,
});
```

### ✅ NEW (required)

```typescript
// Tools delegate to service layer via GitProvider
const factory = container.resolve<GitProviderFactory>(GitProviderFactoryToken);
const provider = await factory.getProvider();
const result = await provider.status(options, context);
```

### Benefits

- **Single execution path** - Easier to maintain, debug, and secure
- **Better abstraction** - Tools don't know if git is CLI, isomorphic, or API-based
- **Easier testing** - Mock `IGitProvider` interface instead of git commands
- **Consistent error handling** - All git errors mapped to `McpError` in one place

## See Also

- [Tool Development Guide](./tool-development-guide.md) - How to use GitProvider in tools
- [`src/services/git/`](../src/services/git/) - Full implementation
- [`src/services/git/core/IGitProvider.ts`](../src/services/git/core/IGitProvider.ts) - Interface definition
