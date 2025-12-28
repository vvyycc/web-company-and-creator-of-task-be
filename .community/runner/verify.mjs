#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SPEC_DIR = path.join(process.cwd(), ".community", "verification");

const args = process.argv.slice(2);
const taskArg = args.find((a) => a.startsWith("--task="));
const taskIdFilter = taskArg ? taskArg.replace("--task=", "").trim() : null;

const log = (msg) => console.log(msg);

const safeExec = (command) => {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    return "";
  }
};

const detectBaseRef = () => {
  const candidates = ["origin/main", "origin/master", "main", "master"];
  for (const ref of candidates) {
    try {
      execSync(`git rev-parse --verify ${ref}`, { stdio: "ignore" });
      return ref;
    } catch (e) {
      // ignore
    }
  }
  return "origin/main";
};

const listSpecFiles = () => {
  if (!fs.existsSync(SPEC_DIR)) return [];
  return fs
    .readdirSync(SPEC_DIR)
    .filter((f) => /^task-.*\.json$/i.test(f))
    .map((f) => path.join(SPEC_DIR, f))
    .filter((f) => (taskIdFilter ? f.includes(`task-${taskIdFilter}.json`) : true));
};

const describeRule = (rule) => {
  if (!rule) return "";
  if (rule.op === "exists") return `exists: ${rule.path}`;
  if (rule.op === "changed") return `changed: ${rule.path}`;
  if (rule.op === "contains") return `contains: ${rule.path} -> ${rule.value}`;
  if (rule.op === "regex") return `regex: ${rule.path} /${rule.value}/`;
  return "";
};

const gitList = (pattern) => {
  const out = safeExec(`git ls-files "${pattern}"`);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
};

const ruleCheckers = {
  exists: (rule) => {
    const matches = gitList(rule.path);
    return { ok: matches.length > 0, details: matches };
  },
  changed: (rule) => {
    const base = detectBaseRef();
    const out = safeExec(`git diff --name-only ${base}...HEAD -- "${rule.path}"`);
    const files = out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    return { ok: files.length > 0, details: files };
  },
  contains: (rule) => {
    const matches = gitList(rule.path);
    if (!matches.length) return { ok: false, details: [`No files match ${rule.path}`] };
    const hit = matches.find((file) => {
      try {
        const raw = fs.readFileSync(file, "utf8");
        return raw.includes(rule.value);
      } catch (e) {
        return false;
      }
    });
    return { ok: !!hit, details: hit ? [hit] : [] };
  },
  regex: (rule) => {
    const matches = gitList(rule.path);
    if (!matches.length) return { ok: false, details: [`No files match ${rule.path}`] };
    const regex = new RegExp(rule.value);
    const hit = matches.find((file) => {
      try {
        const raw = fs.readFileSync(file, "utf8");
        return regex.test(raw);
      } catch (e) {
        return false;
      }
    });
    return { ok: !!hit, details: hit ? [hit] : [] };
  },
};

const evaluateExpectation = (spec, expectation) => {
  const rules = Array.isArray(expectation.rules) ? expectation.rules : [];
  if (!rules.length) {
    return { ok: false, ruleResults: [], message: "No rules defined" };
  }

  const ruleResults = rules.map((rule) => {
    const fn = ruleCheckers[rule.op];
    if (!fn) return { rule, ok: false, details: ["unsupported rule"] };
    const result = fn(rule);
    return { rule, ok: !!result.ok, details: result.details || [] };
  });

  const ok = ruleResults.every((r) => r.ok);
  return { ok, ruleResults, message: ok ? "PASSED" : "FAILED" };
};

const evaluateSpec = (specPath) => {
  const raw = fs.readFileSync(specPath, "utf8");
  const spec = JSON.parse(raw);
  const expectations = Array.isArray(spec.expectations) ? spec.expectations : [];

  const results = expectations.map((expectation) => {
    const res = evaluateExpectation(spec, expectation);
    return { expectation, ...res };
  });

  const ok = results.every((r) => r.ok);
  return { spec, specPath, ok, results };
};

const main = () => {
  const specFiles = listSpecFiles();
  if (!specFiles.length) {
    console.error("No verification specs found in .community/verification");
    process.exit(1);
  }

  const allResults = specFiles.map((file) => evaluateSpec(file));

  for (const specResult of allResults) {
    log(`\nSpec: ${path.basename(specResult.specPath)} => ${specResult.ok ? "PASSED" : "FAILED"}`);
    for (const result of specResult.results) {
      log(`  - ${result.expectation.key}: ${result.ok ? "PASSED" : "FAILED"}`);
      result.ruleResults.forEach((rr) => {
        log(
          `      ${rr.ok ? "✔" : "✖"} ${describeRule(rr.rule)}${
            rr.details.length ? ` (${rr.details.join(", ")})` : ""
          }`
        );
      });
      if (!result.ruleResults.length) {
        log("      ✖ No rules to evaluate");
      }
    }
  }

  const allOk = allResults.every((r) => r.ok);
  log(`\nSummary: ${allOk ? "PASSED" : "FAILED"} (${allResults.filter((r) => r.ok).length}/${allResults.length} specs)`);
  process.exit(allOk ? 0 : 1);
};

main();
