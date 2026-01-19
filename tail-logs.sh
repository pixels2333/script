#!/usr/bin/env bash
set -euo pipefail

out_file="${1:-worker.logs.jsonl}"
env_name="${2:-}"
worker_name="${3:-}"

# Streams Cloudflare Worker logs to a local file (JSONL).
# Requires: wrangler installed and authenticated.

if ! command -v wrangler >/dev/null 2>&1; then
	echo "wrangler not found. Install it first: npm i -g wrangler" >&2
	exit 127
fi

has_config="false"
[[ -f "./wrangler.toml" || -f "./wrangler.json" || -f "./wrangler.jsonc" ]] && has_config="true"

problems=()
if [[ "$has_config" != "true" && -z "$worker_name" ]]; then
	problems+=("Missing Worker name. Pass it as 3rd arg or add wrangler.toml.")
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
	problems+=("CLOUDFLARE_API_TOKEN is not set. In non-interactive shells, set it before running.")
fi

if (( ${#problems[@]} > 0 )); then
	echo "Cannot start log tailing:" >&2
	for p in "${problems[@]}"; do echo "- $p" >&2; done
	echo "" >&2
	echo "Examples:" >&2
	echo "  export CLOUDFLARE_API_TOKEN='<token>'" >&2
	echo "  ./tail-logs.sh worker.logs.jsonl '' '<worker-name>'" >&2
	echo "  ./tail-logs.sh worker.logs.jsonl production '<worker-name>'" >&2
	exit 2
fi

args=(tail --format json)
if [[ -n "$env_name" ]]; then
	args+=(--env "$env_name")
fi
if [[ -n "$worker_name" ]]; then
	args+=(--name "$worker_name")
fi

echo "Writing logs to: $out_file" >&2
echo "Running: wrangler ${args[*]}" >&2

# In JSON mode, each log line is a single JSON object (good for JSONL).
# tee appends to file and also prints to stdout for live viewing.
wrangler "${args[@]}" 2>&1 | tee -a "$out_file"
