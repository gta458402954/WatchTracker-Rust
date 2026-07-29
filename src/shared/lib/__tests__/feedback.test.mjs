import assert from "node:assert/strict";
import test from "node:test";

import {
  errorCategory,
  notifyOperationFailure,
  publicFailureMessage,
  reportOperationFailure,
} from "../feedback.ts";

test("publicFailureMessage returns a fixed user-safe message", () => {
  assert.equal(publicFailureMessage("保存记录"), "保存记录失败，请稍后重试。");
});

test("errorCategory exposes only the error type", () => {
  assert.equal(errorCategory(new TypeError("secret database detail")), "TypeError");
  assert.equal(errorCategory("raw backend error"), "string");
});

test("reportOperationFailure does not log the raw error message", () => {
  const originalError = console.error;
  const captured = [];
  console.error = (...args) => captured.push(args);

  try {
    reportOperationFailure("record.save", new Error("private filesystem path"));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(captured, [
    ["[record.save] operation failed", { errorCategory: "Error" }],
  ]);
});

test("an injected write failure produces one generic user notification", () => {
  const originalError = console.error;
  const capturedLogs = [];
  const capturedNotices = [];
  console.error = (...args) => capturedLogs.push(args);

  try {
    const message = notifyOperationFailure(
      "Record.Save",
      "保存记录",
      new Error("SQL: credentials and private path"),
      (tone, notice) => capturedNotices.push({ tone, message: notice }),
    );
    assert.equal(message, "保存记录失败，请稍后重试。");
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(capturedNotices, [
    { tone: "error", message: "保存记录失败，请稍后重试。" },
  ]);
  assert.deepEqual(capturedLogs, [
    ["[Record.Save] operation failed", { errorCategory: "Error" }],
  ]);
});
