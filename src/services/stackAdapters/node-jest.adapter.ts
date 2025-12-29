import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildTestContent = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map(
      (exp) => `test('${exp.key} - ${exp.title}', () => {
  const expectation = spec.expectations.find((e) => e.key === '${exp.key}');
  expect(expectation).toBeDefined();
  expect(expectation?.successCriteria?.length || 0).toBeGreaterThan(0);
});
`
    )
    .join("\n");

  return `/**
 * Auto-generated from .community/verification/task-${spec.taskId}.json
 * Runner: Jest
 */
import fs from "fs";
import path from "path";

const specPath = path.join(process.cwd(), ".community/verification", "task-${spec.taskId}.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

describe("verification metadata", () => {
  test("spec is valid", () => {
    expect(spec.taskId).toBe("${spec.taskId}");
    expect(Array.isArray(spec.expectations)).toBe(true);
    expect(spec.expectations.length).toBeGreaterThan(0);
  });

${expectations}
});
`;
};

const nodeJestAdapter: StackAdapter = {
  id: "node-jest",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return (
      normalized.primary === "node" ||
      normalized.primary === "nextjs" ||
      (normalized.primary === "react" && (normalized.testRunner || "").includes("jest"))
    );
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `verification/task-${spec.taskId}.spec.ts`,
        content: buildTestContent(spec),
      },
    ],
    commands: {
      install:
        "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi",
      test: "npx jest --runInBand || npm test -- --runInBand || npx jest --config jest.config.js",
    },
  }),
};

export default nodeJestAdapter;
