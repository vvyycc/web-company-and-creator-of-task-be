import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildPytestContent = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map(
      (exp) => `def test_${exp.key.replace(/[^a-zA-Z0-9_]/g, "_")}(spec):
    expectation = next((e for e in spec["expectations"] if e["key"] == "${exp.key}"), None)
    assert expectation is not None
    assert len(expectation.get("successCriteria", [])) > 0`
    )
    .join("\n\n");

  return `# Auto-generated from .community/verification/task-${spec.taskId}.json
import json
from pathlib import Path


def load_spec():
    spec_path = Path.cwd() / ".community" / "verification" / "task-${spec.taskId}.json"
    return json.loads(spec_path.read_text())


def test_metadata():
    spec = load_spec()
    assert spec.get("taskId") == "${spec.taskId}"
    assert len(spec.get("expectations", [])) > 0


${expectations}


def pytest_generate_tests(metafunc):
    if "spec" in metafunc.fixturenames:
        metafunc.parametrize("spec", [load_spec()])
`;
};

const pythonPytestAdapter: StackAdapter = {
  id: "python-pytest",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return normalized.primary === "python" || normalized.testRunner === "pytest";
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `tests/test_task_${spec.taskId}.py`,
        content: buildPytestContent(spec),
      },
    ],
    commands: {
      install: "if [ -f requirements.txt ]; then pip install -r requirements.txt; fi",
      test: "pytest -q",
    },
  }),
};

export default pythonPytestAdapter;
