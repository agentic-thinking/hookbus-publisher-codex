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

```bash
git clone https://github.com/agentic-thinking/hookbus-publisher-codex
cd hookbus-publisher-codex
./install.sh
```

The installer copies `codex-gate` to `~/.local/bin/`, enables Codex hooks, and writes `~/.codex/hooks.json`.

Set your HookBus endpoint and token before installing if you want them written into the hook commands:

```bash
export HOOKBUS_URL=http://localhost:18800/event
export HOOKBUS_TOKEN=<your-hookbus-token>
./install.sh
```

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

This repository ships [`agenthook.publisher.json`](./agenthook.publisher.json), a draft AgentHook publisher manifest. It declares the stable publisher ID, runtime, supported lifecycle events, limitations, config files, and verification commands in one machine-readable file.

HookBus and other collectors can use the manifest to show publisher onboarding state and hook coverage, but they should still verify live events before reporting a publisher as active.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | Bus HTTP endpoint |
| `HOOKBUS_TOKEN` | empty | Bearer token for authenticated bus |
| `HOOKBUS_SOURCE` | `codex` | Dashboard source label |
| `HOOKBUS_TIMEOUT` | `30` | HTTP timeout in seconds |
| `HOOKBUS_FAIL_MODE` | `open` | `open` allows on bus failure; `closed` denies `PreToolUse` on bus failure |
| `HOOKBUS_DEBUG` | empty | Set to `1` for diagnostic logs on stderr |
| `HOOKBUS_SURFACE_ALLOW_CONTEXT` | empty | Set to `1` to show HookBus allow reasons inside Codex. Default is quiet. |

Do not export `HOOKBUS_SOURCE` globally on shared hosts. Keep it pinned inline per hook command so different publishers are labelled correctly.

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
          { "type": "command", "command": "env HOOKBUS_SOURCE=codex codex-gate", "timeout": 30 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_SOURCE=codex codex-gate", "timeout": 30 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_SOURCE=codex codex-gate", "timeout": 30 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_SOURCE=codex codex-gate", "timeout": 30 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "env HOOKBUS_SOURCE=codex codex-gate", "timeout": 30 }
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
