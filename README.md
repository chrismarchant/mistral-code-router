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
  The job is created with `input_files: [file_id]` and `timeout_hours` (from `completion_window`, `"1h"`–`"168h"`, default `"24h"`). All requests are validated (non-empty, unique `custom_id`, non-empty `task`, valid `temperature`, sandboxed `files`) before any network call.
- `mistral_batch_status({ job_id })` — poll until `router.terminal` is true (`SUCCESS`, `FAILED`, `TIMEOUT_EXCEEDED`, `CANCELLED`).
- `mistral_batch_results({ job_id })` — downloads the output file (and error file, if any) and returns `{status, terminal, ok, results: [{custom_id, status_code, content, usage, error}], errors}`. Non-terminal jobs return empty results with a note; failed, cancelled or expired jobs return whatever partial output and errors exist.

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
| `MISTRAL_API_BASE` | `https://api.mistral.ai/v1` | endpoint; must be `https://api.mistral.ai/...` unless custom bases are allowed |
| `MISTRAL_ROUTER_ALLOW_CUSTOM_BASE` | unset | set to `1` to allow any http(s) `MISTRAL_API_BASE` |
| `MAX_CONTEXT_CHARS` | `200000` | cap on total file context characters per request |
| `MISTRAL_ROUTER_ALLOWED_ROOTS` | unset | extra workspace roots for `files`, separated by `:` (`;` on Windows) |
| `MISTRAL_ROUTER_MAX_FILE_BYTES` | `524288` | per-file size cap (512 KiB), checked before reading |
| `MISTRAL_ROUTER_MAX_FILES` | `50` | maximum number of entries in `files` |

## Security

The `files` parameter reads local files and sends their contents to the API, so
it is sandboxed and **fails closed**: if any requested path is rejected, the
whole call fails before any request is sent. The error names each path as given
and the reason (`outside_root`, `symlink_escape`, `sensitive`,
`not_regular_file`, `too_large`, `not_found`, or `too_many_files`); file
contents are never included in errors.

- **Approved roots.** The server's working directory, plus any directories in
  `MISTRAL_ROUTER_ALLOWED_ROOTS`. Roots are canonicalised (`realpath`) at
  startup; entries that do not exist are ignored with a warning on stderr.
- **Canonical resolution.** Every path is resolved with `realpath` (symlinks
  followed) and must land inside an approved root (`path.relative`
  containment, so `/x/root-evil` is not inside `/x/root`). A symlink inside a
  root that points outside is rejected as `symlink_escape`. Only regular files
  are read: no directories, devices, FIFOs, globbing or traversal.
- **Sensitive exclusions** (on the canonical path and on the path as requested,
  even inside a root): `.env` and `.env.*` (except `.env.example`,
  `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` (and `.pub`),
  anything under `.ssh/`, `.aws/`, `.gnupg/`, `.git/`, `.kube/`,
  `.docker/config.json`, `.netrc`, `.npmrc`, `.pypirc`, `credentials`,
  `credentials.json`, `secrets.*`, `*.tfstate`, `*.tfvars`,
  `settings.local.json` (anywhere, including `.claude/`), `.claude.json`.
  Files whose content contains a PEM private-key header
  (`-----BEGIN ... PRIVATE KEY-----`) are also refused.
- **Limits.** Per-file byte cap (checked via `stat` before reading), file-count
  cap, and the total `MAX_CONTEXT_CHARS` cap (later files are truncated or
  marked `omitted`).
- **Base-URL allowlist.** The bearer key is only sent to
  `https://api.mistral.ai`. Any other `MISTRAL_API_BASE` makes every API tool
  call fail with a clear error unless `MISTRAL_ROUTER_ALLOW_CUSTOM_BASE=1`.
  API error bodies are truncated in tool errors; the key is never logged.

### Batch billing (HTTP 402)

An HTTP 402 from any endpoint (commonly `POST /v1/batch/jobs`) is reported as
an account-level billing blocker, not a software fault. Do not retry; resolve
billing or credits for the key in the Mistral console first.

### Model parameters

- `temperature` must be a finite number in `[0, 2]`.
- `mistral-large-4-0` (`lechonk`) rejects greedy sampling unless `top_p` is 1,
  so `temperature: 0` automatically sends `top_p: 1` for that model. Rules live
  in `MODEL_PARAM_POLICIES` in `server.js`; other models and raw IDs pass
  parameters through unchanged.
- GLM and Large 4 can return `message.content` as blocks (`thinking` then
  `text`). Tool results return only the concatenated `text` blocks as a string.

### Proxy in sandboxed cloud sessions

Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`
(Node 22.21+ / 24.5+). In a cloud session that routes egress through a proxy,
export `NODE_USE_ENV_PROXY=1` in the session environment so the MCP server
process inherits it.

## Tests

```bash
npm test   # node --test mcp-server/test/*.test.js — no dependencies, no network
```

## Notes / guardrails

- Context is passed as file paths + snippets, capped server-side — pass targeted
  files, not whole repos.
- Per-call `max_tokens` / `timeout_ms`; on failure the worker falls back to doing
  the work locally.
- Check `usage` in tool results for cost; `glm-flash` is the budget route.
- To distribute later, push this folder to a GitHub repo and install with
  `/plugin install mistral-router@user/repo` — not required for local use.
