import assert from "node:assert/strict";
import test from "node:test";

import {
  errorCategory,
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
