#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/bin/codex-gate.js"
BIN_DIR="$HOME/.local/bin"
DST="$BIN_DIR/codex-gate"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_DIR/config.toml"
HOOKS="$CODEX_DIR/hooks.json"

say() { printf "\033[1;32m[codex-publisher]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[codex-publisher]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[codex-publisher] error:\033[0m %s\n" "$*"; exit 1; }

[ -f "$SRC" ] || die "missing $SRC"
command -v node >/dev/null || die "node is required"

mkdir -p "$BIN_DIR" "$CODEX_DIR"
install -Dm755 "$SRC" "$DST"
say "installed $DST"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH. Add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

BUS_URL="${HOOKBUS_URL:-http://localhost:18800/event}"
TOKEN="${HOOKBUS_TOKEN:-YOUR_TOKEN_HERE}"
FAIL_MODE="${HOOKBUS_FAIL_MODE:-open}"
HOOK_CMD="env HOOKBUS_URL=$BUS_URL HOOKBUS_TOKEN=$TOKEN HOOKBUS_SOURCE=codex HOOKBUS_FAIL_MODE=$FAIL_MODE $DST"

if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak.hookbus-$(date +%Y%m%d-%H%M%S)"
fi

CONFIG_PATH="$CONFIG" python3 <<'PY'
import os
from pathlib import Path

path = Path(os.environ["CONFIG_PATH"])
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

has_features = any(line.strip() == "[features]" for line in lines)
if not has_features:
    if lines and lines[-1].strip():
        lines.append("")
    lines.append("[features]")
    lines.append("codex_hooks = true")
else:
    out = []
    in_features = False
    seen = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if in_features and not seen:
                out.append("codex_hooks = true")
                seen = True
            in_features = stripped == "[features]"
        if in_features and stripped.startswith("codex_hooks"):
            out.append("codex_hooks = true")
            seen = True
            continue
        out.append(line)
    if in_features and not seen:
        out.append("codex_hooks = true")
    lines = out

path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY
chmod 600 "$CONFIG"
say "enabled codex_hooks in $CONFIG"

if [ -f "$HOOKS" ]; then
  cp "$HOOKS" "$HOOKS.bak.hookbus-$(date +%Y%m%d-%H%M%S)"
fi

HOOKBUS_HOOK_COMMAND="$HOOK_CMD" HOOKS_PATH="$HOOKS" python3 <<'PY'
import json
import os
from pathlib import Path

events = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")
path = Path(os.environ["HOOKS_PATH"])
command = os.environ["HOOKBUS_HOOK_COMMAND"]

data = {}
if path.exists() and path.read_text(encoding="utf-8").strip():
    data = json.loads(path.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("hooks.json root must be an object")

root = data.setdefault("hooks", {})
if not isinstance(root, dict):
    raise SystemExit("hooks.json hooks field must be an object")

for event in events:
    data.pop(event, None)

for event in events:
    entries = root.get(event)
    if not isinstance(entries, list):
        entries = []
    kept = [
        group for group in entries
        if not (
            isinstance(group, dict)
            and any(
                isinstance(handler, dict) and "codex-gate" in str(handler.get("command", ""))
                for handler in group.get("hooks", [])
            )
        )
    ]
    group = {
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": 30,
            "statusMessage": f"HookBus {event}",
        }],
    }
    if event in {"PreToolUse", "PostToolUse"}:
        group["matcher"] = "Bash"
    elif event == "SessionStart":
        group["matcher"] = "startup|resume"
    kept.append(group)
    root[event] = kept

path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$HOOKS"
say "updated $HOOKS"

cat <<EOF

Codex HookBus publisher installed.

Restart Codex so config and hooks are reloaded.
If you used YOUR_TOKEN_HERE, edit $HOOKS and replace it with your HookBus token.
EOF
