/**
 * @fileoverview CLI provider git clone operation
 * @module services/git/providers/cli/operations/core/clone
 */

import * as path from 'node:path';

import type { RequestContext } from '@/utils/index.js';

import type {
  GitCloneOptions,
  GitCloneResult,
  GitOperationContext,
} from '../../../../types.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git clone to clone a repository.
 */
export async function executeClone(
  options: GitCloneOptions,
  context: GitOperationContext,
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
): Promise<GitCloneResult> {
  try {
    // Resolve localPath to absolute and get parent directory
    // Clone must run from parent dir since target doesn't exist yet
    // See: https://github.com/cyanheads/git-mcp-server/pull/33
    const absoluteLocalPath = path.resolve(options.localPath);
    const parentDir = path.dirname(absoluteLocalPath);
    const targetDirName = path.basename(absoluteLocalPath);

    const args: string[] = [options.remoteUrl, targetDirName];

    if (options.branch) {
      args.push('--branch', options.branch);
    }

    if (options.depth) {
      args.push('--depth', options.depth.toString());
    }

    if (options.bare) {
      args.push('--bare');
    }

    if (options.mirror) {
      args.push('--mirror');
    }

    if (options.recurseSubmodules) {
      args.push('--recurse-submodules');
    }

    const cmd = buildGitCommand({ command: 'clone', args });
    // Run from parent directory, clone into target directory name
    await execGit(cmd, parentDir, context.requestContext);

    const result = {
      success: true,
      localPath: absoluteLocalPath,
      remoteUrl: options.remoteUrl,
      branch: options.branch || 'main',
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'clone');
  }
}
