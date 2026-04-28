import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gate = join(__dirname, "..", "bin", "codex-gate.js");

function runGate(input, { decision = "allow", reason = "ok", statusCode = 200, token = "test-token" } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.statusCode = statusCode;
      res.end(JSON.stringify({ event_id: seen[0]?.body?.event_id || "event-1", decision, reason }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/event`;
      const child = spawn(process.execPath, [gate], {
        env: {
          ...process.env,
          HOOKBUS_URL: url,
          HOOKBUS_TOKEN: token,
          HOOKBUS_SOURCE: "codex-test",
          HOOKBUS_USER_ID: "user-123",
          HOOKBUS_INSTANCE_ID: "runtime-instance-01",
          HOOKBUS_HOST_ID: "host-01",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        server.close();
        resolve({ code, stdout, stderr, seen });
      });
      child.stdin.end(JSON.stringify(input));
    });
  });
}

test("PreToolUse allow posts AgentHook envelope", async () => {
  const result = await runGate({
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });

  assert.equal(result.code, 0);
  assert.equal(result.seen.length, 1);
  assert.equal(result.seen[0].body.event_type, "PreToolUse");
  assert.equal(result.seen[0].body.source, "codex-test");
  assert.equal(result.seen[0].body.tool_name, "Bash");
  assert.equal(result.seen[0].body.metadata.publisher, "hookbus-publisher-codex");
  assert.equal(result.seen[0].body.metadata.publisher_id, "uk.agenticthinking.publisher.openai.codex-cli");
  assert.equal(result.seen[0].body.metadata.user_id, "user-123");
  assert.equal(result.seen[0].body.metadata.instance_id, "runtime-instance-01");
  assert.equal(result.seen[0].body.metadata.host_id, "host-01");
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("PreToolUse deny exits 2 with Codex permission denial", async () => {
  const result = await runGate({
    hook_event_name: "PreToolUse",
    session_id: "sess-2",
    tool_name: "Bash",
    tool_input: { command: "disallowed-test-command" },
  }, { decision: "deny", reason: "blocked" });

  assert.equal(result.code, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, "blocked");
  assert.match(result.stderr, /blocked/);
});

test("Stop maps to ModelResponse with reasoning unavailable metadata", async () => {
  const result = await runGate({
    hook_event_name: "Stop",
    session_id: "sess-3",
    last_assistant_message: "done",
    transcript_path: "/tmp/codex-transcript.jsonl",
  });

  assert.equal(result.code, 0);
  assert.equal(result.seen[0].body.event_type, "ModelResponse");
  assert.equal(result.seen[0].body.tool_name, "model.response");
  assert.equal(result.seen[0].body.metadata.response_available, true);
  assert.equal(result.seen[0].body.metadata.response_text, "done");
  assert.equal(result.seen[0].body.metadata.reasoning_available, false);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("UserPromptSubmit allow reason is quiet by default", async () => {
  const result = await runGate({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-4",
    prompt: "hello",
  }, { decision: "allow", reason: "not gated" });

  assert.equal(result.code, 0);
  assert.equal(result.seen[0].body.event_type, "UserPromptSubmit");
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("non-2xx HookBus responses are treated as transport failures", async () => {
  const result = await runGate({
    hook_event_name: "PreToolUse",
    session_id: "sess-5",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  }, { statusCode: 401, decision: "allow", reason: "unauthorised" });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("fail-closed denies PreToolUse on non-2xx HookBus response", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "unauthorised" }));
    });
  });

  const result = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/event`;
      const child = spawn(process.execPath, [gate], {
        env: {
          ...process.env,
          HOOKBUS_URL: url,
          HOOKBUS_TOKEN: "wrong-token",
          HOOKBUS_SOURCE: "codex-test",
          HOOKBUS_FAIL_MODE: "closed",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        server.close();
        resolve({ code, stdout });
      });
      child.stdin.end(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "sess-6",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
      }));
    });
  });

  assert.equal(result.code, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /HTTP 401/);
});

test("omits Authorization header when HOOKBUS_TOKEN is empty", async () => {
  const result = await runGate({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-7",
    prompt: "hello",
  }, { token: "" });

  assert.equal(result.code, 0);
  assert.equal(result.seen[0].headers.authorization, undefined);
});

test("doctor validates config, hooks, and bus event path", async () => {
  const codeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  writeFileSync(join(codeHome, "config.toml"), "[features]\ncodex_hooks = true\n");
  writeFileSync(join(codeHome, "hooks.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "env HOOKBUS_SOURCE=codex /tmp/codex-gate" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "env HOOKBUS_SOURCE=codex /tmp/codex-gate" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "env HOOKBUS_SOURCE=codex /tmp/codex-gate" }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "env HOOKBUS_SOURCE=codex /tmp/codex-gate" }] }],
      Stop: [{ hooks: [{ type: "command", command: "env HOOKBUS_SOURCE=codex /tmp/codex-gate" }] }],
    },
  }));

  const server = createServer((req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ decision: "allow", reason: "doctor ok" }));
  });

  const result = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/event`;
      const child = spawn(process.execPath, [gate, "--doctor"], {
        env: {
          ...process.env,
          CODEX_HOME: codeHome,
          HOOKBUS_URL: url,
          HOOKBUS_TOKEN: "doctor-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        server.close();
        resolve({ code, stdout, stderr });
      });
    });
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Doctor passed/);
  assert.match(result.stdout, /already-running Codex TUI/);
  assert.doesNotMatch(result.stdout, /doctor-token/);
});
