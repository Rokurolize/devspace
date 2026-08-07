import { createHash } from "node:crypto";

function metadataString(
  meta: unknown,
  key: string,
): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function openAiConversationScopeId(
  meta: unknown,
): string | undefined {
  const session = metadataString(meta, "openai/session");
  return session ? correlationHash("openai-session", session) : undefined;
}

export function correlationHash(namespace: string, value: string): string {
  return createHash("sha256")
    .update(JSON.stringify([namespace, value]))
    .digest("hex");
}
