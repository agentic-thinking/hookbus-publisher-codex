# hookbus-publisher-codex

Publishes OpenAI Codex CLI hook events to **HookBus**, the vendor-neutral event bus for AI agent runtimes.

Codex fires hooks when a session starts, a user submits a prompt, a tool is about to run, a tool returns, and a turn stops. This publisher forwards those events to HookBus so subscribers can audit, enrich, or gate Codex activity.

## What it does

- Registers Codex CLI hooks in `~/.codex/hooks.json` using Codex's `{"hooks": ...}` schema
- Enables Codex's `codex_hooks` feature in `~/.codex/config.toml`
- Installs a `codex-gate` command that reads Codex hook JSON from stdin
- Posts AgentHook-shaped lifecycle envelopes to HookBus
- Translates HookBus `allow`, `deny`, and `ask` decisions back into Codex hook output
- Fails open by default if HookBus is unreachable, so Codex is not bricked by a missing bus

## Install

### 1. Install HookBus or get access to a central HookBus

For a local development bus, install HookBus Light first and load its environment:

```bash
curl -fsSL https://hookbus.com/install.sh | bash
set -a
source ~/hookbus-light/.env
set +a
export HOOKBUS_URL=http://localhost:18800/event
```

For a shared or central HookBus, ask your HookBus operator for:

```bash
export HOOKBUS_URL=https://hookbus.example.com/event
export HOOKBUS_TOKEN=<hookbus-bearer-token>
export HOOKBUS_INSTANCE_ID=runtime-instance-01
export HOOKBUS_HOST_ID=host-01
```

Use pseudonymous identity values. Do not put personal data, passwords, private addresses, or credentials in identity fields.

### 2. Install the Codex publisher

```bash
git clone https://github.com/agentic-thinking/hookbus-publisher-codex
cd hookbus-publisher-codex
./install.sh
```

The installer copies `codex-gate` to `~/.local/bin/codex-gate`, enables Codex hooks in `~/.codex/config.toml`, and writes HookBus commands into `~/.codex/hooks.json`.

The installer prints the exact HookBus URL it wrote into the Codex hook file. If it detects multiple local HookBus endpoints, it warns you; make sure you open the dashboard for the same bus.

If `~/.local/bin` is not on your `PATH`, Codex hooks still work because the installer writes an absolute command path. Add it to `PATH` only if you want to run `codex-gate` manually:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3. Avoid stale config

The HookBus URL, token, fail mode, and identity fields are written into `~/.codex/hooks.json` during install. If any of these change, rerun:

```bash
./install.sh
```

Do not rely on changing shell exports after installation; Codex will keep using the inline values already written to the hook file.

### 4. Verify the install

Run the doctor:

```bash
~/.local/bin/codex-gate --doctor
```

The doctor checks that Codex hooks are enabled, `~/.codex/hooks.json` contains HookBus handlers, the bus URL is valid, and a harmless test event is accepted by HookBus.

Fully quit and restart Codex after installation so it reloads `~/.codex/config.toml` and `~/.codex/hooks.json`. Already-running Codex sessions do not reload hook changes.

## Codex hook coverage

| Codex hook | AgentHook event sent to HookBus | Delivery | Can block? |
|---|---|---|---|
| `SessionStart` | `SessionStart` | sync | no |
| `UserPromptSubmit` | `UserPromptSubmit` | sync | no |
| `PreToolUse` | `PreToolUse` | sync | yes |
| `PostToolUse` | `PostToolUse` | sync/observe | no |
| `Stop` | `ModelResponse` | sync/observe | no |

Codex does not currently expose a dedicated raw `PreLLMCall` / `PostLLMCall` hook surface to this publisher. The `Stop` hook is mapped to AgentHook `ModelResponse` and includes response metadata when Codex supplies it. Reasoning content is marked unavailable unless a future Codex hook payload exposes it.

## AgentHook publisher manifest

This repository ships [`agenthook.publisher.json`](./agenthook.publisher.json), an interim AgentHook publisher manifest for today's non-standard hook surfaces. It declares the stable publisher ID, runtime, supported lifecycle events, limitations, config files, and verification commands in one machine-readable file ahead of native AgentHook adoption.

HookBus and other collectors can use the manifest to show publisher onboarding state and hook coverage, but they should still verify live events before reporting a publisher as active.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | Bus HTTP endpoint |
| `HOOKBUS_TOKEN` | empty | Bearer token for authenticated bus |
| `HOOKBUS_SOURCE` | `codex` | Dashboard source label |
| `HOOKBUS_TIMEOUT` | `30` | HTTP timeout in seconds |
| `HOOKBUS_FAIL_MODE` | `open` | `open` allows on bus failure; `closed` denies `PreToolUse` on bus failure |
| `HOOKBUS_PUBLISHER_ID` | `uk.agenticthinking.publisher.openai.codex-cli` | Stable publisher type identifier |
| `HOOKBUS_USER_ID` | empty | Optional user or pseudonymous user reference for shared buses |
| `HOOKBUS_ACCOUNT_ID` | empty | Optional runtime/provider account reference |
| `HOOKBUS_INSTANCE_ID` | empty | Optional local publisher/runtime instance ID |
| `HOOKBUS_HOST_ID` | empty | Optional pseudonymous host, container, or workload ID |
| `HOOKBUS_DEBUG` | empty | Set to `1` for diagnostic logs on stderr |
| `HOOKBUS_SURFACE_ALLOW_CONTEXT` | empty | Set to `1` to show HookBus allow reasons inside Codex. Default is quiet. |

Do not export `HOOKBUS_SOURCE` globally on shared hosts. Keep it pinned inline per hook command so different publishers are labelled correctly.

For a central HookBus shared by multiple users or machines, set at least `HOOKBUS_INSTANCE_ID` before installing. Use pseudonymous IDs; do not put raw personal data, passwords, tokens, private IPs, or credentials in identity fields. Pseudonymous IDs are still attributable operational metadata and should follow your retention and access-control policy.

## Manual configuration

Enable hooks in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Write `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_URL=http://localhost:18800/event HOOKBUS_SOURCE=codex /home/you/.local/bin/codex-gate", "timeout": 30 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_URL=http://localhost:18800/event HOOKBUS_SOURCE=codex /home/you/.local/bin/codex-gate", "timeout": 30 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_URL=http://localhost:18800/event HOOKBUS_SOURCE=codex /home/you/.local/bin/codex-gate", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_URL=http://localhost:18800/event HOOKBUS_SOURCE=codex /home/you/.local/bin/codex-gate", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_URL=http://localhost:18800/event HOOKBUS_SOURCE=codex /home/you/.local/bin/codex-gate", "timeout": 30 }
        ]
      }
    ]
  }
}
```

## Failure behaviour

If HookBus is unreachable, the publisher fails open by default. Codex continues normally.

For governance-mode deployments:

```bash
export HOOKBUS_FAIL_MODE=closed
```

In fail-closed mode, unreachable HookBus blocks `PreToolUse` events. Observational events still return a neutral response so the CLI is not disrupted after an action has already completed.

Codex currently rejects `permissionDecision: "allow"` and `permissionDecision: "ask"` from `PreToolUse` hook output. This publisher returns `{}` on allow. If HookBus returns `ask`, the publisher blocks the tool and reports the approval request as a denial reason so the user can approve through the configured workflow.

Allow verdict reasons are not surfaced into the Codex session by default. This keeps harmless subscriber messages such as "not gated" or "No subscribers matched" out of the conversation. Set `HOOKBUS_SURFACE_ALLOW_CONTEXT=1` only when debugging context injection.

## Test

```bash
npm test
```

## Trademarks

OpenAI, Codex, and GPT are trademarks of OpenAI OpCo LLC. Used here nominatively to identify the CLI this publisher integrates with. No affiliation with, endorsement by, or sponsorship from OpenAI is claimed or implied.

HookBus is a trademark of Agentic Thinking Limited.

## License

MIT. See [`LICENSE`](./LICENSE).

## Related

- [HookBus](https://github.com/agentic-thinking/hookbus)
- [AgentHook](https://github.com/agentic-thinking/agenthook)
- [hookbus-publisher-claude-code](https://github.com/agentic-thinking/hookbus-publisher-claude-code)
