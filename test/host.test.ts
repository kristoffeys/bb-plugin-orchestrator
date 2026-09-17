import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFeatureWorktree, removeFeatureWorktree } from "../lib/worktree.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();

test("creates an isolated feature worktree without disturbing a dirty source checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktree-"));
  const sourcePath = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await exec("mkdir", ["-p", sourcePath, dataDir]);
  await git(sourcePath, "init");
  await git(sourcePath, "config", "user.name", "Orchestrator Test");
  await git(sourcePath, "config", "user.email", "orchestrator@example.invalid");
  await writeFile(path.join(sourcePath, "tracked.txt"), "committed\n");
  await git(sourcePath, "add", "tracked.txt");
  await git(sourcePath, "commit", "-m", "initial");
  const sourceBranch = await git(sourcePath, "branch", "--show-current");
  await writeFile(path.join(sourcePath, "tracked.txt"), "local edit\n");
  await writeFile(path.join(sourcePath, "untracked.txt"), "private draft\n");

  try {
    const created = await createFeatureWorktree({
      sourcePath,
      pathKey: "session-api",
      branchName: "orchestrator/common-feature",
      baseRef: "HEAD",
      dataDir,
    });
    assert.equal(created.sourceDirty, true);
    assert.equal(created.sourceBranch, sourceBranch);
    assert.equal(await git(created.path, "branch", "--show-current"), "orchestrator/common-feature");
    assert.equal(await git(created.path, "status", "--porcelain=v1"), "");
    assert.equal(await readFile(path.join(created.path, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(await readFile(path.join(sourcePath, "tracked.txt"), "utf8"), "local edit\n");
    assert.equal(await readFile(path.join(sourcePath, "untracked.txt"), "utf8"), "private draft\n");
    assert.equal(await git(sourcePath, "branch", "--show-current"), sourceBranch);
    await removeFeatureWorktree({ sourcePath, worktreePath: created.path });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explains how to fix a checkout with no baseline commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-unborn-"));
  const sourcePath = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  await exec("mkdir", ["-p", sourcePath, dataDir]);
  await git(sourcePath, "init");
  await writeFile(path.join(sourcePath, "untracked.txt"), "draft\n");
  try {
    await assert.rejects(createFeatureWorktree({ sourcePath, pathKey: "session-empty", branchName: "orchestrator/feature", baseRef: "HEAD", dataDir }), /has no commits.*Commit a baseline/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
