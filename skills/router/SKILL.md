---
name: mistral-router
description: Route independent Claude Code workstreams to Mistral-hosted models (Mistral Large 4 "Le Chonk", Z.ai GLM 5.3, DeepSeek V4.1 Flash 1017) in parallel via the bundled mistral_delegate MCP tool. Use when a task decomposes into multiple independent pieces that can run concurrently on remote models.
---

# Mistral Router

This plugin offloads parallel workstreams from a Claude Code session to models
hosted on Mistral's API (`https://api.mistral.ai/v1/chat/completions`), through
the bundled `mistral_delegate` MCP tool. One API key (`MISTRAL_API_KEY`) covers
all routes; only the `model` field changes.

## Model selection policy

| Alias | Model ID | Use for |
|---|---|---|
| `lechonk` | `mistral-large-4-0` | Architecture, design reviews, complex refactors, nuanced trade-off analysis |
| `glm` | `zai-glm-5-3` | Agentic multi-file coding workstreams, reasoning-heavy implementation |
| `deepseek` | `deepseek-v4-1-flash-1017` | Long-context coding tasks, bulk code generation |
| `glm-flash` | `zai-glm-5-3-flash` | Budget default: tests, docs, boilerplate, high-volume generation |

Call `mistral_models` to see the live map. Raw Mistral model IDs also pass through.

## How to fan out work

1. **Decompose** the user's goal into independent workstreams (disjoint files or
   concerns). If workstreams depend on each other, keep them in the local session.
2. **Spawn workers in parallel**: invoke multiple `workstream-worker` subagents in
   a single block (parallel Agent tool calls), one per workstream, each with its
   task and assigned model alias. Or use `/parallel <task>`.
3. **Each worker** reads the files it needs, calls `mistral_delegate` with
   `files` (paths relative to cwd) and/or `context`, and `json: true`.
4. **Merge** the workers' strict-JSON results locally: apply edits, resolve
   conflicts, and report a single summary to the user.

## Output contract

Workers must return strict JSON so the coordinator can merge mechanically:

```json
{
  "status": "done | needs-review | blocked",
  "model": "zai-glm-5-3",
  "files_to_edit": ["src/foo.ts"],
  "changes": "...",
  "summary": "...",
  "open_questions": []
}
```

## Batch mode (async, discounted)

For many non-interactive workstreams (tests, docs, per-file reviews), prefer one
Mistral **batch job** over N live calls — invoke `/parallel --batch <task>`:

- `mistral_batch_submit({ model, requests: [{custom_id, task, files, context, json, max_tokens}] })` → `job_id`
- `mistral_batch_status({ job_id })` → poll until `SUCCESS` / `FAILED`
- `mistral_batch_results({ job_id })` → `[{custom_id, status_code, content, usage, error}]`

Batch jobs are asynchronous (completion window defaults to 24h) and cheaper, but
the remote model cannot use tools or see follow-ups — keep interactive,
latency-sensitive workstreams on `mistral_delegate`. Results map back by
`custom_id` and use the same strict-JSON contract as live workers.

## Guardrails

- Pass targeted file paths + snippets, not whole repos; total context is capped
  by `MAX_CONTEXT_CHARS` (default 200000) server-side.
- Set `max_tokens` and `timeout_ms` per call; on API failure or timeout, fall
  back to doing the work locally in the Claude session.
- Never send secrets; `MISTRAL_API_KEY` lives in the environment, never in prompts.
- Watch `usage` in the tool result to keep per-workstream cost bounded.
