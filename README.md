# mistral-code-router

A Claude Code **plugin** that routes parallel workstreams to Mistral-hosted
models — Mistral Large 4 ("Le Chonk"), Z.ai GLM 5.3, DeepSeek V4.1 Flash 1017 —
through one bundled, zero-dependency MCP server. Same core pattern as
`chrismarchant/mistral-code-review-bot` (thin orchestrator → `POST
https://api.mistral.ai/v1/chat/completions` → structured JSON back), but the
transport is MCP-inside-a-session instead of a GitHub webhook.

## Layout

```
mistral-code-router/
├── .claude-plugin/plugin.json     # plugin manifest
├── .mcp.json                      # bundled MCP server (stdio, node)
├── mcp-server/server.js           # zero-dep MCP server: mistral_delegate, mistral_models, mistral_batch_submit/status/results
├── skills/router/SKILL.md         # routing policy + fan-out protocol
├── commands/parallel.md           # /parallel <task>
└── agents/workstream-worker.md    # per-workstream subagent
```

## Requirements

- Node.js >= 18 (for global `fetch`); no `npm install` needed.
- A Mistral API key: `export MISTRAL_API_KEY=...` (get one at
  https://console.mistral.ai). The key is read from the environment only.

## Install

### From the local folder

In Claude Code, from any project:

```
/plugin install /Users/christophermarchant/mistral-code-router
```

### From GitHub (any machine, cloud session, or container)

The plugin is the repo root of `chrismarchant/mistral-code-router`, so a plain clone works with no build step:

```bash
git clone https://github.com/chrismarchant/mistral-code-router.git ~/mistral-code-router
claude --plugin-dir ~/mistral-code-router
```

Or install via the marketplace in a session:

```
/plugin marketplace add chrismarchant/mistral-code-router
/plugin install mistral-router@mistral-code-router
```

Container bootstrap — clone in the image, inject the key at **runtime** only
(never bake it into the image; the plugin's `.mcp.json` expands
`${MISTRAL_API_KEY}` from the session env):

```dockerfile
RUN git clone https://github.com/chrismarchant/mistral-code-router.git /opt/mistral-code-router
# run with: docker run -e MISTRAL_API_KEY=... <image> claude --plugin-dir /opt/mistral-code-router
```

Never commit secrets: `.claude/settings.local.json` and `*.env` are git-ignored.

or add the MCP server manually to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "mistral-router": {
      "command": "node",
      "args": ["/Users/christophermarchant/mistral-code-router/mcp-server/server.js"],
      "env": { "MISTRAL_API_KEY": "${MISTRAL_API_KEY}" }
    }
  }
}
```

If Claude Code prompts for approval on `mistral_delegate` / `mistral_models`,
allowlist them in settings so parallel workers don't stall.

## Usage

- `/parallel Refactor the auth module into middleware + tests` — coordinator
  decomposes, spawns parallel `workstream-worker` subagents, each offloading to
  an assigned model, then merges the strict-JSON results.
- Or call the tools directly in a session:
  - `mistral_models` — show the alias → model-ID map.
  - `mistral_delegate({ model: "glm", task: "...", files: ["src/a.ts"], json: true })` — one live workstream.

## Batch mode (async, discounted)

For many non-interactive workstreams, use `/parallel --batch <task>` or the batch
tools directly (see https://docs.mistral.ai/inference/batch-processing):

- `mistral_batch_submit({ model: "glm-flash", requests: [{ custom_id: "ws-0", task: "...", files: ["src/a.ts"], json: true }] })` → uploads a JSONL input file (`POST /v1/files`, purpose `batch`) and creates a job (`POST /v1/batch/jobs`, endpoint `/v1/chat/completions`) → returns `job_id`.
- `mistral_batch_status({ job_id })` — poll until `SUCCESS` / `FAILED`.
- `mistral_batch_results({ job_id })` — downloads the output file and returns `[{custom_id, status_code, content, usage, error}]`.

Batch is asynchronous (default completion window 24h) and cheaper, but the remote
model cannot use tools in batch mode — use it for test/doc generation, per-file
reviews, and other non-interactive fan-outs.

## Model map (all on `https://api.mistral.ai/v1/chat/completions`)

| Alias | Model ID | Use for |
|---|---|---|
| `lechonk` | `mistral-large-4-0` | design/architecture, complex refactors |
| `glm` | `zai-glm-5-3` | agentic multi-file coding |
| `deepseek` | `deepseek-v4-1-flash-1017` | long-context coding |
| `glm-flash` | `zai-glm-5-3-flash` | cheap default: tests, docs, boilerplate |

Raw Mistral model IDs (e.g. `mistral-large-latest`, `codestral-latest`) are also
accepted as `model`.

## Configuration (env)

| Var | Default | Description |
|---|---|---|
| `MISTRAL_API_KEY` | — | required |
| `MISTRAL_API_BASE` | `https://api.mistral.ai/v1` | override endpoint |
| `MAX_CONTEXT_CHARS` | `200000` | cap on file context sent per delegate call |

## Notes / guardrails

- Context is passed as file paths + snippets, capped server-side — pass targeted
  files, not whole repos.
- Per-call `max_tokens` / `timeout_ms`; on failure the worker falls back to doing
  the work locally.
- Check `usage` in tool results for cost; `glm-flash` is the budget route.
- To distribute later, push this folder to a GitHub repo and install with
  `/plugin install mistral-router@user/repo` — not required for local use.
