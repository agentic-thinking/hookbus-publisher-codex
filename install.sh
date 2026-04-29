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

detect_local_hookbus_endpoints() {
  python3 <<'PY'
import http.client
import json
from urllib.parse import urlparse

for port in (18800, 18811):
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.8)
        conn.request(
            "POST",
            "/event",
            body=json.dumps({
                "event_id": f"installer-probe-{port}",
                "event_type": "UserPromptSubmit",
                "timestamp": "2026-01-01T00:00:00Z",
                "source": "codex-installer-probe",
                "session_id": "installer-probe",
                "tool_name": "",
                "tool_input": {},
                "metadata": {"probe": True},
            }),
            headers={"Content-Type": "application/json"},
        )
        res = conn.getresponse()
        res.read()
        if res.status in (200, 400, 401, 403):
            print(f"http://localhost:{port}/event {res.status}")
    except Exception:
        pass
PY
}

[ -f "$SRC" ] || die "missing $SRC"
command -v node >/dev/null || die "node is required"

load_hookbus_env() {
  if [[ -z "${HOOKBUS_TOKEN:-}" && -f "$HOME/hookbus-light/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$HOME/hookbus-light/.env"
    set +a
  fi
}

load_hookbus_env

mkdir -p "$BIN_DIR" "$CODEX_DIR"
install -Dm755 "$SRC" "$DST"
say "installed $DST"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH. Add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

BUS_URL="${HOOKBUS_URL:-http://localhost:18800/event}"
TOKEN="${HOOKBUS_TOKEN:-}"
FAIL_MODE="${HOOKBUS_FAIL_MODE:-open}"
PUBLISHER_ID="${HOOKBUS_PUBLISHER_ID:-uk.agenticthinking.publisher.openai.codex-cli}"

shell_quote() {
  printf "%q" "$1"
}

HOOK_CMD="env HOOKBUS_URL=$(shell_quote "$BUS_URL")"
if [ -n "$TOKEN" ]; then
  HOOK_CMD="$HOOK_CMD HOOKBUS_TOKEN=$(shell_quote "$TOKEN")"
else
  warn "HOOKBUS_TOKEN is not set. The hook command will omit auth; authenticated buses will reject events."
fi
HOOK_CMD="$HOOK_CMD HOOKBUS_SOURCE=codex HOOKBUS_FAIL_MODE=$(shell_quote "$FAIL_MODE") HOOKBUS_PUBLISHER_ID=$(shell_quote "$PUBLISHER_ID")"
for name in HOOKBUS_USER_ID HOOKBUS_ACCOUNT_ID HOOKBUS_INSTANCE_ID HOOKBUS_HOST_ID; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    HOOK_CMD="$HOOK_CMD $name=$(shell_quote "$value")"
  fi
done
HOOK_CMD="$HOOK_CMD $(shell_quote "$DST")"

mapfile -t LOCAL_BUSES < <(detect_local_hookbus_endpoints || true)
if [ "${#LOCAL_BUSES[@]}" -gt 1 ]; then
  warn "multiple local HookBus-like endpoints were detected:"
  for endpoint in "${LOCAL_BUSES[@]}"; do
    warn "  $endpoint"
  done
  warn "this Codex publisher is being installed for: $BUS_URL"
  warn "make sure you open the dashboard for the same bus."
fi

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

Installed bus:
  $BUS_URL

Installed files:
  gate:   $DST
  config: $CONFIG
  hooks:  $HOOKS

Important: fully quit and restart Codex. Already-running Codex sessions do not reload hooks.

Run a verification check:

  $DST --doctor

If your bus requires authentication, rerun the installer with HOOKBUS_TOKEN set.
EOF
