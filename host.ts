import { experimental_defineHostEntry, experimental_killProcessesWithCwdUnder } from "@get-bb/plugin-sdk/host";
import { worktreeHostContract } from "./lib/host-contract.ts";
import { createFeatureWorktree, removeFeatureWorktree } from "./lib/worktree.ts";

export default experimental_defineHostEntry({
  contract: worktreeHostContract,
  handlers: {
    createWorktree: async ({ sourcePath, pathKey, branchName, baseRef }, context) => createFeatureWorktree({ sourcePath, pathKey, branchName, baseRef, dataDir: context.experimental_paths.dataDir, signal: context.signal }),
    removeWorktree: async ({ sourcePath, path: worktreePath }) => removeFeatureWorktree({ sourcePath, worktreePath, killProcesses: async (directory) => experimental_killProcessesWithCwdUnder({ directory }) }),
  },
});
