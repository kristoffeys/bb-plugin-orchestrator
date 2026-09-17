import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const worktreeHostContract = defineRpcContract({
  createWorktree: {
    input: z.object({ sourcePath: z.string().min(1), pathKey: z.string().min(1), branchName: z.string().min(1), baseRef: z.string().min(1) }).strict(),
    output: z.object({ path: z.string().min(1), headSha: z.string().min(1), sourceBranch: z.string().nullable(), sourceDirty: z.boolean() }).strict(),
  },
  removeWorktree: {
    input: z.object({ sourcePath: z.string().min(1), path: z.string().min(1) }).strict(),
    output: z.object({ removed: z.literal(true) }).strict(),
  },
});
