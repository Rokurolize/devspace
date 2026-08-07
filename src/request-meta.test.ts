import assert from "node:assert/strict";
import test from "node:test";
import { correlationHash, openAiConversationScopeId } from "./request-meta.js";

test("undefined request metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId(undefined), undefined);
});

test("missing session metadata has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({}), undefined);
});

test("an empty session string has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
});

test("a non-string session value has no conversation scope", () => {
  assert.equal(openAiConversationScopeId({ "openai/session": 42 }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": {} }), undefined);
});

test("valid OpenAI session metadata returns a stable redacted scope", () => {
  const scope = openAiConversationScopeId({
    "openai/session": "chat-session-opaque-value",
  });
  assert.match(scope ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    scope,
    openAiConversationScopeId({ "openai/session": "chat-session-opaque-value" }),
  );
  assert.notEqual(scope, "chat-session-opaque-value");
});

test("unrelated metadata fields do not alter the selected conversation scope", () => {
  assert.equal(
    openAiConversationScopeId({
      "openai/session": "chat-session-opaque-value",
      "openai/subject": "user-1",
      "openai/organization": "org-1",
    }),
    correlationHash("openai-session", "chat-session-opaque-value"),
  );
});
