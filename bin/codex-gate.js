#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.0";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function debug(message) {
  if (process.env.HOOKBUS_DEBUG === "1") {
    process.stderr.write(`[hookbus-codex] ${message}\n`);
  }
}

function info(message) {
  process.stdout.write(`${message}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (process.stdin.isTTY) resolve("");
  });
}

function safeJson(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    debug(`stdin JSON parse failed: ${error.message}`);
    return {};
  }
}

function truncate(value, max = 4000) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function optionalIdentityMetadata() {
  const fields = {
    publisher_id: env("HOOKBUS_PUBLISHER_ID", "uk.agenticthinking.publisher.openai.codex-cli"),
    user_id: env("HOOKBUS_USER_ID"),
    account_id: env("HOOKBUS_ACCOUNT_ID"),
    instance_id: env("HOOKBUS_INSTANCE_ID"),
    host_id: env("HOOKBUS_HOST_ID"),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

function hookName(input) {
  return input.hook_event_name || input.hookEventName || input.event || "";
}

function mapEventType(hook) {
  if (hook === "Stop") return "ModelResponse";
  return hook || "PreToolUse";
}

function toolInputFor(hook, input) {
  if (input.tool_input && typeof input.tool_input === "object") return input.tool_input;
  if (input.toolInput && typeof input.toolInput === "object") return input.toolInput;
  if (hook === "UserPromptSubmit") return { prompt: input.prompt || input.user_prompt || "" };
  return {};
}

function modelResponseMetadata(input) {
  const response = input.last_assistant_message || input.response || input.output_text || "";
  const transcriptPath = input.transcript_path || input.transcriptPath || "";
  return {
    codex_hook_event: "Stop",
    response_available: Boolean(response),
    response_text: truncate(response, 4000),
    response_chars: typeof response === "string" ? response.length : 0,
    reasoning_available: false,
    reasoning_redacted: false,
    reasoning_unavailable_reason: "codex_stop_hook_does_not_expose_reasoning_content",
    transcript_available: Boolean(transcriptPath),
    transcript_path: transcriptPath,
  };
}

function buildEnvelope(input) {
  const hook = hookName(input);
  const eventType = mapEventType(hook);
  const source = env("HOOKBUS_SOURCE", "codex");
  const metadata = {
    publisher: "hookbus-publisher-codex",
    publisher_version: VERSION,
    agenthook_standard: "https://agenthook.org",
    codex_hook_event: hook || "unknown",
    cwd: input.cwd || process.cwd(),
    model: input.model || "",
    ...optionalIdentityMetadata(),
  };

  if (eventType === "ModelResponse") {
    Object.assign(metadata, modelResponseMetadata(input));
  }

  return {
    schema_version: 1,
    event_id: randomUUID(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    source,
    session_id: input.session_id || input.sessionId || `${source}-${hostname()}-${process.pid}`,
    tool_name: input.tool_name || input.toolName || (eventType === "ModelResponse" ? "model.response" : ""),
    tool_input: toolInputFor(hook, input),
    metadata,
  };
}

function postEvent(envelope, { busUrlOverride = undefined, tokenOverride = undefined } = {}) {
  const busUrl = busUrlOverride === undefined ? env("HOOKBUS_URL", "http://localhost:18800/event") : String(busUrlOverride);
  const timeoutMs = Number.parseInt(env("HOOKBUS_TIMEOUT", "30"), 10) * 1000;
  const token = tokenOverride === undefined ? env("HOOKBUS_TOKEN", "").trim() : String(tokenOverride || "").trim();

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(busUrl);
    } catch (error) {
      reject(new Error(`Invalid HOOKBUS_URL: ${error.message}`));
      return;
    }

    const body = JSON.stringify(envelope);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search || ""}`,
      method: "POST",
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HookBus returned HTTP ${res.statusCode}${data ? `: ${truncate(data, 240)}` : ""}`));
          return;
        }
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({
            decision: String(parsed.decision || "allow").toLowerCase(),
            reason: parsed.reason || "",
            raw: parsed,
          });
        } catch (error) {
          reject(new Error(`HookBus returned non-JSON response (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("HookBus timeout"));
    });
    req.write(body);
    req.end();
  });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function hasCodexHooksEnabled(configText) {
  return /^\s*codex_hooks\s*=\s*true\s*$/m.test(configText);
}

function hooksJsonStatus(hooksText) {
  if (!hooksText.trim()) return { ok: false, detail: "missing or empty hooks.json" };
  let data;
  try {
    data = JSON.parse(hooksText);
  } catch (error) {
    return { ok: false, detail: `invalid JSON: ${error.message}` };
  }
  const root = data && typeof data === "object" ? data.hooks : null;
  if (!root || typeof root !== "object") return { ok: false, detail: "missing hooks root" };
  const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
  const missing = required.filter((event) => {
    const groups = root[event];
    return !Array.isArray(groups) || !groups.some((group) => (
      group && Array.isArray(group.hooks) && group.hooks.some((handler) => (
        handler && typeof handler.command === "string" && handler.command.includes("codex-gate")
      ))
    ));
  });
  if (missing.length) return { ok: false, detail: `missing HookBus handlers for: ${missing.join(", ")}` };
  return { ok: true, detail: "HookBus handlers installed" };
}

function shellUnquote(value) {
  if (!value) return "";
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value.replace(/\\(.)/g, "$1");
}

function extractInstalledHookEnv(hooksText) {
  const result = {};
  if (!hooksText.trim()) return result;
  let data;
  try {
    data = JSON.parse(hooksText);
  } catch {
    return result;
  }
  const root = data && typeof data === "object" ? data.hooks : null;
  if (!root || typeof root !== "object") return result;

  for (const groups of Object.values(root)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const handler of handlers) {
        const command = handler && typeof handler.command === "string" ? handler.command : "";
        if (!command.includes("codex-gate")) continue;
        for (const key of ["HOOKBUS_URL", "HOOKBUS_TOKEN", "HOOKBUS_SOURCE", "HOOKBUS_FAIL_MODE", "HOOKBUS_INSTANCE_ID"]) {
          const match = command.match(new RegExp(`(?:^|\\s)${key}=((?:'[^']*(?:'\\\\''[^']*)*')|(?:\"(?:\\\\.|[^\"])*\")|(?:\\\\.|\\S)+)`));
          if (match) result[key] = shellUnquote(match[1]);
        }
        return result;
      }
    }
  }
  return result;
}

async function doctor() {
  info("Codex HookBus doctor");
  info("This validates the installed gate, Codex hook files, and HookBus event path.");
  info("It cannot prove that an already-running Codex TUI has reloaded hooks; restart Codex after install.\n");

  const codeHome = env("CODEX_HOME", join(env("HOME", ""), ".codex"));
  const configPath = join(codeHome, "config.toml");
  const hooksPath = join(codeHome, "hooks.json");
  const hooksText = readText(hooksPath);
  const installedEnv = extractInstalledHookEnv(hooksText);
  const doctorBusUrl = installedEnv.HOOKBUS_URL || env("HOOKBUS_URL", "http://localhost:18800/event");
  const doctorToken = installedEnv.HOOKBUS_TOKEN !== undefined ? installedEnv.HOOKBUS_TOKEN : env("HOOKBUS_TOKEN", "").trim();
  const checks = [];

  function check(name, ok, detail = "") {
    checks.push({ name, ok, detail });
    info(`${ok ? "ok" : "fail"} ${name}${detail ? ` - ${detail}` : ""}`);
  }

  let urlOk = true;
  try {
    new URL(doctorBusUrl);
  } catch (error) {
    urlOk = false;
    check("HOOKBUS_URL", false, error.message);
  }
  if (urlOk) check("HOOKBUS_URL", true, doctorBusUrl);
  if (installedEnv.HOOKBUS_URL && env("HOOKBUS_URL", "") && installedEnv.HOOKBUS_URL !== env("HOOKBUS_URL", "")) {
    info(`warn shell HOOKBUS_URL differs from installed hook URL; doctor is testing installed hook URL.`);
  }

  check("codex-gate", existsSync(process.argv[1]), process.argv[1]);
  check("codex config", hasCodexHooksEnabled(readText(configPath)), configPath);
  const hooksStatus = hooksJsonStatus(hooksText);
  check("codex hooks", hooksStatus.ok, `${hooksPath}: ${hooksStatus.detail}`);

  try {
    const envelope = buildEnvelope({
      hook_event_name: "UserPromptSubmit",
      session_id: `codex-doctor-${Date.now()}`,
      prompt: "hookbus doctor test",
      cwd: process.cwd(),
    });
    const verdict = await postEvent(envelope, { busUrlOverride: doctorBusUrl, tokenOverride: doctorToken });
    check("hookbus event", true, `accepted with decision=${verdict.decision || "allow"}`);
  } catch (error) {
    check("hookbus event", false, error.message);
  }

  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length) {
    info(`\nDoctor failed: ${failed.length} check(s) failed.`);
    return 1;
  }
  info("\nDoctor passed.");
  return 0;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function neutralFor(hook) {
  if (hook === "Stop" || hook === "SessionStart") return {};
  return {};
}

function emitDeny(hook, reason) {
  if (hook === "PreToolUse") {
    if (reason) process.stderr.write(`${reason}\n`);
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    return;
  }

  if (hook === "Stop") {
    emit({ decision: "block", reason });
    return;
  }

  emit({ systemMessage: reason });
}

function emitAsk(hook, reason) {
  if (hook === "PreToolUse") {
    emitDeny(hook, `Approval required: ${reason}`);
    return;
  }
  emit(neutralFor(hook));
}

function emitAllow(hook, reason) {
  if (hook === "PreToolUse") {
    emit({});
    return;
  }
  if (process.env.HOOKBUS_SURFACE_ALLOW_CONTEXT === "1" && reason && ["PostToolUse", "UserPromptSubmit"].includes(hook)) {
    emit({
      hookSpecificOutput: {
        hookEventName: hook,
        additionalContext: reason,
      },
    });
    return;
  }
  if (process.env.HOOKBUS_SURFACE_ALLOW_CONTEXT === "1" && reason && ["SessionStart", "Stop"].includes(hook)) {
    emit({ systemMessage: reason });
    return;
  }
  emit(neutralFor(hook));
}

export async function main() {
  const input = safeJson(await readStdin());
  const hook = hookName(input);
  const envelope = buildEnvelope(input);

  let verdict;
  try {
    verdict = await postEvent(envelope);
  } catch (error) {
    debug(`post failed: ${error.message}`);
    const failMode = env("HOOKBUS_FAIL_MODE", "open").toLowerCase();
    if (failMode === "closed" && hook === "PreToolUse") {
      emitDeny(hook, `HookBus unavailable: ${error.message}`);
      return 2;
    }
    emit(neutralFor(hook));
    return 0;
  }

  if (verdict.decision === "deny") {
    emitDeny(hook, verdict.reason);
    return 2;
  }
  if (verdict.decision === "ask") {
    emitAsk(hook, verdict.reason);
    return 0;
  }
  emitAllow(hook, verdict.reason);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const entry = process.argv.includes("--doctor") ? doctor : main;
  entry()
    .then((code) => process.exit(typeof code === "number" ? code : 0))
    .catch((error) => {
      process.stderr.write(`[hookbus-codex] crashed: ${error.message}\n`);
      process.exit(2);
    });
}
