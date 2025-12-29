import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";

const buildContent = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map((exp) => `- ${exp.key}: ${exp.title} (${exp.type})`)
    .join("\\n");

  return `// Auto-generated fallback verification for unsupported stack.
// Please implement stack-specific verification based on the agnostic expectations.

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const specPath = path.join(process.cwd(), ".community/verification", "task-${spec.taskId}.json");
const raw = fs.readFileSync(specPath, "utf8");
const spec = JSON.parse(raw);

describe("verification fallback", () => {
  it("should list expectations so developers can implement them", () => {
    assert.ok(Array.isArray(spec.expectations) && spec.expectations.length > 0, "missing expectations");
  });

  it("reminds developers to implement stack specific tests", () => {
    assert.fail(\`No adapter available for stack \${spec.stack?.primary || "unknown"}. Expectations:\\n${expectations}\`);
  });
});
`;
};

const fallbackAdapter: StackAdapter = {
  id: "fallback-unsupported",
  match: () => true,
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `verification/task-${spec.taskId}.spec.js`,
        content: buildContent(spec),
      },
    ],
    commands: {
      install: "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi",
      test: "node --test verification/task-*.spec.js || npm test -- --runInBand",
    },
  }),
};

export default fallbackAdapter;
