import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildPhpUnitContent = (spec: VerificationSpec) => {
  const methods = spec.expectations
    .map(
      (exp, idx) => `    public function test_${idx}_${exp.key.replace(/[^a-zA-Z0-9_]/g, "_")}(): void
    {
        $found = false;
        foreach ($this->spec['expectations'] as $item) {
            if ($item['key'] === '${exp.key}') {
                $found = true;
                break;
            }
        }
        $this->assertTrue($found, 'Expectation ${exp.key} missing');
    }`
    )
    .join("\n\n");

  return `<?php
// Auto-generated verification test for task ${spec.taskId}

use PHPUnit\\Framework\\TestCase;

final class Task${spec.taskId}Test extends TestCase
{
    private array $spec;

    protected function setUp(): void
    {
        $path = __DIR__ . '/../.community/verification/task-${spec.taskId}.json';
        $this->spec = json_decode(file_get_contents($path), true);
    }

    public function test_spec_metadata(): void
    {
        $this->assertEquals('${spec.taskId}', $this->spec['taskId']);
        $this->assertNotEmpty($this->spec['expectations']);
    }

${methods}
}
`;
};

const phpPhpunitAdapter: StackAdapter = {
  id: "php-phpunit",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return normalized.primary === "php" || normalized.testRunner === "phpunit";
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `tests/Task${spec.taskId}Test.php`,
        content: buildPhpUnitContent(spec),
      },
    ],
    commands: {
      install: "if [ -f composer.json ]; then composer install --no-interaction --no-progress; fi",
      test: "vendor/bin/phpunit --testsuite default || vendor/bin/phpunit",
    },
  }),
};

export default phpPhpunitAdapter;
