import { VerificationSpec } from "../verificationSpec";
import { ProjectStack, normalizeProjectStack } from "../../models/stack";
import nodeJestAdapter from "./node-jest.adapter";
import reactViteVitestAdapter from "./react-vite-vitest.adapter";
import solidityHardhatAdapter from "./solidity-hardhat.adapter";
import pythonPytestAdapter from "./python-pytest.adapter";
import javaMavenJunitAdapter from "./java-maven-junit.adapter";
import phpPhpunitAdapter from "./php-phpunit.adapter";
import fallbackAdapter from "./fallback.adapter";

export type AdapterCommands = {
  install?: string;
  test?: string;
};

export type AdapterResult = {
  files: Array<{ path: string; content: string }>;
  commands: AdapterCommands;
};

export interface StackAdapter {
  id: string;
  match: (stack: ProjectStack) => boolean;
  generate: (spec: VerificationSpec) => AdapterResult;
}

const adapters: StackAdapter[] = [
  nodeJestAdapter,
  reactViteVitestAdapter,
  solidityHardhatAdapter,
  pythonPytestAdapter,
  javaMavenJunitAdapter,
  phpPhpunitAdapter,
];

export const getStackAdapter = (stack: ProjectStack): StackAdapter => {
  const normalized = normalizeProjectStack(stack);
  return adapters.find((adapter) => adapter.match(normalized)) || fallbackAdapter;
};

export default adapters;
