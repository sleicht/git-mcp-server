/**
 * @fileoverview CLI provider git commit operation
 * @module services/git/providers/cli/operations/commits/commit
 */

import type { RequestContext } from '@/utils/index.js';

import type {
  GitCommitOptions,
  GitCommitResult,
  GitOperationContext,
} from '../../../../types.js';
import {
  buildGitCommand,
  GIT_FIELD_DELIMITER,
  GIT_RECORD_DELIMITER,
  mapGitError,
  shouldSignCommits,
} from '../../utils/index.js';

/**
 * Execute git commit to create a new commit.
 */
export async function executeCommit(
  options: GitCommitOptions,
  context: GitOperationContext,
  execGit: (
    args: string[],
    cwd: string,
    ctx: RequestContext,
  ) => Promise<{ stdout: string; stderr: string }>,
): Promise<GitCommitResult> {
  try {
    const args: string[] = ['-m', options.message];

    if (options.amend) {
      args.push('--amend');
    }

    if (options.allowEmpty) {
      args.push('--allow-empty');
    }

    if (options.noVerify) {
      args.push('--no-verify');
    }

    if (options.author) {
      const authorStr = `${options.author.name} <${options.author.email}>`;
      args.push(`--author=${authorStr}`);
    }

    // Add signing support - use explicit option or fall back to config default
    const shouldSign = options.sign ?? shouldSignCommits();

    // Try with signing first (if enabled)
    let commitError: unknown = null;
    if (shouldSign) {
      try {
        const signedArgs = [...args, '--gpg-sign'];
        const cmd = buildGitCommand({ command: 'commit', args: signedArgs });
        await execGit(cmd, context.workingDirectory, context.requestContext);
        // Success with signing - continue to get commit details
      } catch (error) {
        // If signing fails and forceUnsignedOnFailure is true, retry without signing
        if (options.forceUnsignedOnFailure) {
          commitError = error; // Store error to retry
        } else {
          throw error; // Fail immediately if forceUnsignedOnFailure is false/undefined
        }
      }
    }

    // If we haven't committed yet (either no signing or signing failed with forceUnsignedOnFailure)
    if (commitError !== null || !shouldSign) {
      // Explicitly disable signing with --no-gpg-sign
      const unsignedArgs = [...args, '--no-gpg-sign'];
      const cmd = buildGitCommand({ command: 'commit', args: unsignedArgs });
      await execGit(cmd, context.workingDirectory, context.requestContext);
    }

    // Get commit hash reliably
    const hashCmd = buildGitCommand({
      command: 'rev-parse',
      args: ['HEAD'],
    });
    const hashResult = await execGit(
      hashCmd,
      context.workingDirectory,
      context.requestContext,
    );
    const commitHash = hashResult.stdout.trim();

    // Get commit details using the reliable hash
    const showCmd = buildGitCommand({
      command: 'show',
      args: [
        `--format=%an${GIT_FIELD_DELIMITER}%at${GIT_RECORD_DELIMITER}`,
        '--name-only',
        commitHash,
      ],
    });
    const showResult = await execGit(
      showCmd,
      context.workingDirectory,
      context.requestContext,
    );

    const parts = showResult.stdout.split(GIT_RECORD_DELIMITER);
    const metaParts = parts[0]?.split(GIT_FIELD_DELIMITER) || [];
    const authorName = metaParts[0] || '';
    const timestamp = parseInt(metaParts[1] || '0', 10);

    // Parse changed files from the second part of the output
    // git show --name-only outputs filenames after the metadata section
    const filesChanged = parts[1]?.split('\n').filter((f) => f.trim()) || [];

    const result = {
      success: true,
      commitHash,
      message: options.message,
      author: authorName,
      timestamp,
      filesChanged,
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'commit');
  }
}
