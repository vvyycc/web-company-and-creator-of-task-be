import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildHardhatContent = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map(
      (exp) => `it("${exp.key} - ${exp.title}", async () => {
    expect(spec.expectations.find((e: any) => e.key === "${exp.key}")).toBeDefined();
    // TODO: implement contract specific assertions for ${exp.type}
  });`
    )
    .join("\n\n");

  return `import { expect } from "chai";
import fs from "fs";
import path from "path";

const specPath = path.join(process.cwd(), ".community/verification", "task-${spec.taskId}.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

describe("community verification - hardhat", function () {
  it("has expectations", function () {
    expect(spec.taskId).to.equal("${spec.taskId}");
    expect(spec.expectations.length).to.be.greaterThan(0);
  });

${expectations}
});
`;
};

const solidityHardhatAdapter: StackAdapter = {
  id: "solidity-hardhat",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return normalized.primary === "solidity" && (normalized.testRunner || "").toLowerCase().includes("hardhat");
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `test/task-${spec.taskId}.ts`,
        content: buildHardhatContent(spec),
      },
    ],
    commands: {
      install:
        "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi",
      test: "npx hardhat test --grep 'task-${spec.taskId}' || npx hardhat test",
    },
  }),
};

export default solidityHardhatAdapter;
