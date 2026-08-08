import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function workspaceResourceKey(
  root: string | undefined,
  workspaceId: string,
): string {
  if (!root) return `workspace:${workspaceId}`;

  const absoluteRoot = resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(absoluteRoot);
  } catch {
    canonicalRoot = absoluteRoot;
  }

  return `root:${canonicalRoot}`;
}
