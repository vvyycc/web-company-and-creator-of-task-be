export type PrimaryStack =
  | "node"
  | "nextjs"
  | "solidity"
  | "python"
  | "java"
  | "php"
  | "react"
  | "angular"
  | "vue"
  | "unknown";

export type ProjectStack = {
  primary: PrimaryStack;
  testRunner?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  framework?: string;
  notes?: string;
};

export const DEFAULT_PROJECT_STACK: ProjectStack = {
  primary: "nextjs",
  testRunner: "jest",
  packageManager: "npm",
};

export const normalizeProjectStack = (stack?: Partial<ProjectStack> | null): ProjectStack => {
  const primary = (stack?.primary as PrimaryStack) || DEFAULT_PROJECT_STACK.primary;

  const guessedRunner = (() => {
    if (stack?.testRunner) return stack.testRunner;
    if (primary === "python") return "pytest";
    if (primary === "java") return "maven";
    if (primary === "php") return "phpunit";
    if (primary === "solidity") return "hardhat";
    if (primary === "react") return "vitest";
    return DEFAULT_PROJECT_STACK.testRunner;
  })();

  const guessedPackageManager =
    (stack?.packageManager as ProjectStack["packageManager"]) || DEFAULT_PROJECT_STACK.packageManager;

  return {
    primary,
    testRunner: guessedRunner,
    packageManager: guessedPackageManager,
    framework: stack?.framework,
    notes: stack?.notes,
  };
};
