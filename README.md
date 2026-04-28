# hookbus-publisher-codex

Publishes OpenAI Codex CLI hook events to **HookBus**, the vendor-neutral event bus for AI agent runtimes.

Codex fires hooks when a session starts, a user submits a prompt, a tool is about to run, a tool returns, and a turn stops. This publisher forwards those events to HookBus so subscribers can audit, enrich, or gate Codex activity.

## What it does

- Registers Codex CLI hooks in `~/.codex/hooks.json`
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

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | Bus HTTP endpoint |
| `HOOKBUS_TOKEN` | empty | Bearer token for authenticated bus |
| `HOOKBUS_SOURCE` | `codex` | Dashboard source label |
| `HOOKBUS_TIMEOUT` | `30` | HTTP timeout in seconds |
| `HOOKBUS_FAIL_MODE` | `open` | `open` allows on bus failure; `closed` denies `PreToolUse` on bus failure |
| `HOOKBUS_DEBUG` | empty | Set to `1` for diagnostic logs on stderr |

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
  "SessionStart": [
    { "command": "env HOOKBUS_SOURCE=codex codex-gate" }
  ],
  "UserPromptSubmit": [
    { "command": "env HOOKBUS_SOURCE=codex codex-gate" }
  ],
  "PreToolUse": [
    { "command": "env HOOKBUS_SOURCE=codex codex-gate" }
  ],
  "PostToolUse": [
    { "command": "env HOOKBUS_SOURCE=codex codex-gate" }
  ],
  "Stop": [
    { "command": "env HOOKBUS_SOURCE=codex codex-gate" }
  ]
}
```

## Failure behaviour

If HookBus is unreachable, the publisher fails open by default. Codex continues normally.

For governance-mode deployments:

```bash
export HOOKBUS_FAIL_MODE=closed
```

In fail-closed mode, unreachable HookBus blocks `PreToolUse` events. Observational events still return a neutral response so the CLI is not disrupted after an action has already completed.

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
