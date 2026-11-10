#!/usr/bin/env zsh
# Safely add MISTRAL_API_KEY to a project's .claude/settings.local.json.
# The key is read with `read -s` (never echoed) and only ever expanded from
# $REPLY, so it never appears on a command line -> not in shell history or ps.
#
# Usage:
#   zsh ~/mistral-code-router/scripts/set-mistral-key.sh /path/to/your/project
#   (defaults to the current directory if no path given)
set -euo pipefail

PROJECT_DIR="${1:-$PWD}"

node --version >/dev/null 2>&1 || { echo "ERROR: node not found (needs >= 18)"; exit 1; }
[ -d "$PROJECT_DIR" ] || { echo "ERROR: not a directory: $PROJECT_DIR"; exit 1; }
cd "$PROJECT_DIR"

echo -n "MISTRAL_API_KEY (input hidden): "
read -s REPLY
echo
if [[ -z "$REPLY" ]]; then
  echo "ERROR: empty key, aborting (nothing written)"
  exit 1
fi
if [[ "$REPLY" != sk-* ]]; then
  echo "WARNING: key does not start with 'sk-' — continuing anyway"
fi

export MISTRAL_API_KEY_TMP="$REPLY"
unset REPLY

node -e '
  const fs = require("fs");
  const p = ".claude/settings.local.json";
  let j = {};
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { /* new file */ }
  fs.mkdirSync(".claude", { recursive: true });
  j.env = Object.assign({}, j.env, { MISTRAL_API_KEY: process.env.MISTRAL_API_KEY_TMP });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log("written " + p);
'
unset MISTRAL_API_KEY_TMP

chmod 600 .claude/settings.local.json

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git check-ignore -q .claude/settings.local.json; then
    echo ".claude/settings.local.json is already git-ignored"
  else
    echo '.claude/settings.local.json' >> .gitignore
    echo "added .claude/settings.local.json to .gitignore"
  fi
else
  echo "not a git repo — skipped .gitignore step"
fi

# Verify without printing the secret: only presence + length.
node -e '
  const j = JSON.parse(require("fs").readFileSync(".claude/settings.local.json", "utf8"));
  const k = j.env && j.env.MISTRAL_API_KEY;
  console.log("verify: key set =", !!k, "| length =", k ? k.length : 0, "| other keys preserved =", Object.keys(j).filter(x => x !== "env").join(", ") || "(none)");
'
echo "done. Relaunch claude in this project so the MCP server picks up the env."
