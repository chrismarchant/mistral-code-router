---
description: Fan a task out to parallel workstreams offloaded to Mistral-hosted models (Le Chonk / GLM 5.3 / DeepSeek). Use "/parallel --batch <task>" for large non-interactive fan-outs via the discounted async batch API.
---

# /parallel

Task from the user: $ARGUMENTS

## Mode selection

- If the task starts with `--batch`, use **batch mode** below.
- Otherwise use **live mode** (parallel workers, immediate results).

## Live mode (default)

1. Decompose the task into independent workstreams (disjoint files or concerns).
   List them explicitly. Anything with cross-workstream dependencies stays local.
2. Choose a model alias per workstream using the mistral-router skill policy:
   `lechonk` (mistral-large-4-0) for design/architecture, `glm` (zai-glm-5-3) for
   agentic multi-file coding, `deepseek` (deepseek-v4-1-flash-1017) for
   long-context work, `glm-flash` (zai-glm-5-3-flash) as the cheap default.
3. Spawn one `workstream-worker` subagent per workstream **in a single parallel
   block**, passing each its workstream description and model alias.
4. Collect each worker's strict-JSON result (`status`, `files_to_edit`,
   `changes`, `summary`, `open_questions`).

## Batch mode (`--batch`)

Use when there are many (roughly >4) **non-interactive** workstreams (test/doc
generation, per-file reviews, migrations) and latency does not matter. Batch is
asynchronous and cheaper, but the remote model cannot use tools or answer
follow-ups.

1. Strip `--batch` from the task; decompose into workstreams as above. Pick one
   model alias for the whole batch (or split into one batch per model).
2. Call `mistral_batch_submit` once with `model` and `requests`: one entry per
   workstream, each `{ custom_id: "ws-<n>", task: "...", files: [...],
   context: "...", json: true, max_tokens: ... }`.
3. Poll `mistral_batch_status({ job_id })` every 30-60s until status is
   `SUCCESS` or `FAILED` (do not spin in a tight loop).
4. Call `mistral_batch_results({ job_id })`; merge results by `custom_id`. Each
   result's `content` follows the same strict-JSON contract as live workers.

## Merge + report (both modes)

- Apply the edits locally; resolve conflicts between workstreams.
- Report one consolidated summary: per-workstream model + token usage, files
  changed, open questions, and the batch job ID in batch mode.
- If a live `mistral_delegate` call fails or times out, retry once, then do that
  workstream locally instead.
