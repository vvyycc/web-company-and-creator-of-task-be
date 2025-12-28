import { strict as assert } from "assert";
import { describe, it } from "node:test";
import { getStackAdapter } from "../services/stackAdapters";
import { ProjectStack } from "../models/stack";

const pick = (stack: ProjectStack) => getStackAdapter(stack).id;

describe("stack adapter selection", () => {
  it("prefers node-jest for node primary", () => {
    assert.equal(pick({ primary: "node", testRunner: "jest", packageManager: "npm" }), "node-jest");
  });

  it("uses react-vite-vitest for react projects", () => {
    assert.equal(pick({ primary: "react", testRunner: "vitest", packageManager: "pnpm" }), "react-vite-vitest");
  });

  it("uses solidity-hardhat for solidity", () => {
    assert.equal(pick({ primary: "solidity", testRunner: "hardhat" }), "solidity-hardhat");
  });

  it("falls back when unknown", () => {
    assert.equal(pick({ primary: "unknown" }), "fallback-unsupported");
  });
});
