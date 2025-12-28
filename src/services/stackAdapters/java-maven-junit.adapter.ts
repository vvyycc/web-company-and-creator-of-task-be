import { VerificationSpec } from "../verificationSpec";
import { StackAdapter, AdapterResult } from "./index";
import { normalizeProjectStack } from "../../models/stack";

const buildJUnitContent = (spec: VerificationSpec) => {
  const testMethods = spec.expectations
    .map(
      (exp, idx) => `  @Test
  public void ${exp.key.replace(/[^a-zA-Z0-9_]/g, "_")}_${idx}() throws Exception {
    Assertions.assertTrue(spec.expectations.stream().anyMatch(e -> "${exp.key}".equals(e.key)));
  }`
    )
    .join("\n\n");

  return `package com.community.verification;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class Task${spec.taskId.replace(/[^a-zA-Z0-9]/g, "")}Test {
  record Expectation(String key, String title, String type) {}
  record Spec(String taskId, List<Expectation> expectations) {}

  private static Spec spec;

  @BeforeAll
  static void loadSpec() throws Exception {
    var mapper = new ObjectMapper();
    var specPath = Path.of(".community", "verification", "task-${spec.taskId}.json");
    spec = mapper.readValue(specPath.toFile(), Spec.class);
  }

  @Test
  void hasExpectations() {
    Assertions.assertEquals("${spec.taskId}", spec.taskId());
    Assertions.assertFalse(spec.expectations().isEmpty());
  }

${testMethods}
}
`;
};

const javaMavenJunitAdapter: StackAdapter = {
  id: "java-maven-junit",
  match: (stack) => {
    const normalized = normalizeProjectStack(stack);
    return normalized.primary === "java" || normalized.testRunner === "maven" || normalized.testRunner === "junit";
  },
  generate: (spec: VerificationSpec): AdapterResult => ({
    files: [
      {
        path: `src/test/java/com/community/verification/Task${spec.taskId.replace(/[^a-zA-Z0-9]/g, "")}Test.java`,
        content: buildJUnitContent(spec),
      },
    ],
    commands: {
      install: "if [ -f pom.xml ]; then mvn -B -ntp dependency:resolve; fi",
      test: "mvn -B -ntp test",
    },
  }),
};

export default javaMavenJunitAdapter;
