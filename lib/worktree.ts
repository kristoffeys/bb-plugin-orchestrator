import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (args: string[], cwd: string, signal?: AbortSignal) => (await exec("git", args, { cwd, signal, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

// Read-only directories (vendored dist folders, some node_modules) make rm fail with EACCES and leak the worktree.
const removeTree = async (target: string) => {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await exec("chmod", ["-R", "u+w", target]).catch(() => undefined);
    await rm(target, { recursive: true, force: true });
  }
};

export async function createFeatureWorktree(input: { sourcePath: string; pathKey: string; branchName: string; baseRef: string; dataDir: string; signal?: AbortSignal }) {
  const { sourcePath, pathKey, branchName, baseRef, dataDir, signal } = input;
  if (path.basename(pathKey) !== pathKey || pathKey === "." || pathKey === "..") throw new Error("Invalid worktree path key.");
  await git(["check-ref-format", "--branch", branchName], sourcePath, signal);
  const headSha = await git(["rev-parse", "HEAD"], sourcePath, signal).catch(() => {
    throw new Error("This project checkout has no commits. Commit a baseline or point the project at a parent repository before starting orchestration.");
  });
  const [sourceBranch, status] = await Promise.all([
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], sourcePath, signal).catch(() => ""),
    git(["status", "--porcelain=v1"], sourcePath, signal),
  ]);
  const root = path.join(dataDir, "worktrees", pathKey);
  const destination = path.join(root, path.basename(sourcePath));
  await removeTree(root);
  await mkdir(root, { recursive: true });
  await git(["worktree", "prune"], sourcePath, signal);
  const branchExists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], sourcePath, signal).then(() => true, () => false);
  try {
    await git(branchExists ? ["worktree", "add", "--force", destination, branchName] : ["worktree", "add", "-b", branchName, destination, baseRef], sourcePath, signal);
  } catch (error) {
    await removeTree(root);
    throw error;
  }
  return { path: destination, headSha, sourceBranch: sourceBranch || null, sourceDirty: status.length > 0 };
}

export async function removeFeatureWorktree(input: { sourcePath: string; worktreePath: string; killProcesses?: (directory: string) => Promise<void> }) {
  if (input.killProcesses !== undefined) await input.killProcesses(input.worktreePath);
  await git(["worktree", "remove", "--force", input.worktreePath], input.sourcePath).catch(() => undefined);
  await removeTree(path.dirname(input.worktreePath));
  await git(["worktree", "prune"], input.sourcePath).catch(() => undefined);
  return { removed: true as const };
}
