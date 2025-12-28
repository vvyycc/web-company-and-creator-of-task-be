import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildVitestContent = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map(
      (exp) => `it('${exp.key} - ${exp.title}', () => {
    const expectation = spec.expectations.find((e) => e.key === '${exp.key}');
    expect(expectation).toBeTruthy();
    expect((expectation?.successCriteria || []).length).toBeGreaterThan(0);
  });`
    )
    .join("\n\n");

  return `import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const specPath = path.join(process.cwd(), ".community/verification", "task-${spec.taskId}.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

describe("community verification - vitest", () => {
  it("has expectations", () => {
    expect(spec.taskId).toBe("${spec.taskId}");
    expect(Array.isArray(spec.expectations)).toBe(true);
    expect(spec.expectations.length).toBeGreaterThan(0);
  });

  ${expectations}
});
`;
};

const reactViteVitestAdapter: StackAdapter = {
  id: "react-vite-vitest",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return normalized.primary === "react" || normalized.testRunner === "vitest" || normalized.framework === "vite";
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `verification/task-${spec.taskId}.spec.ts`,
        content: buildVitestContent(spec),
      },
    ],
    commands: {
      install:
        "if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then pnpm install; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi",
      test: "npx vitest run --reporter=dot || npm test -- --runInBand",
    },
  }),
};

export default reactViteVitestAdapter;
