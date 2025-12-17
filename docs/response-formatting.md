# Response Formatter Guide

**Version:** 2.4.1
**Last Updated:** 2025-10-11

This guide covers the standardized JSON response formatting pattern used in git-mcp-server tools.

## Overview

**As of v2.4.1**, all tools use the `createJsonFormatter` utility for consistent, machine-readable JSON output.

### Why JSON Formatting?

1. **Consistency & Machine Readability**: Structured JSON ensures LLMs can reliably parse tool output
2. **Verbosity Control**: Users can choose `minimal`, `standard`, or `full` detail levels
3. **Complete Context**: LLMs receive complete data needed to answer follow-up questions

## Basic Usage Pattern

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

## Critical Rules for Filter Functions

### ✅ DO:

- Include or omit entire fields based on verbosity level
- Use `shouldInclude(level, 'standard')` for conditional field inclusion
- Return complete arrays when included (LLMs need full context)
- Omit fields entirely at lower verbosity levels if not needed

### ❌ DON'T:

- Truncate arrays (breaks LLM context understanding)
- Return summaries without structured data
- Assume LLM can access the raw output object

### Example - Field Inclusion Pattern

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

## Advanced Features

The `createJsonFormatter` utility provides several helper functions:

- **`filterByVerbosity<T>()`** - Field-based filtering with field lists per level
- **`shouldInclude()`** - Conditional field inclusion helper
- **`mergeFilters<T>()`** - Compose multiple filter functions
- **`createFieldMapper<T, R>()`** - Transform/rename fields during filtering
- **`createConditionalFilter<T>()`** - Apply different filters based on data properties

## When to Skip the Filter Function

If your tool doesn't need verbosity control, you can omit the filter entirely:

```typescript
// Simple tools - always return full output as JSON
const responseFormatter = createJsonFormatter<ToolOutput>();
```

This is appropriate for:

- Simple confirmation operations (init, fetch)
- Tools with minimal output data
- Operations where all data is always relevant

## See Also

- [`src/mcp-server/tools/utils/json-response-formatter.ts`](../src/mcp-server/tools/utils/json-response-formatter.ts) - Implementation
- [`src/mcp-server/tools/definitions/`](../src/mcp-server/tools/definitions/) - Tool examples
