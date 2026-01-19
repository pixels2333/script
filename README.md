# Worker Logs (Local File)

Cloudflare Workers run in an edge runtime and cannot write files into your local project directory.

This folder provides helper scripts to **stream logs from Cloudflare** and **save them to a local file** in the same directory.

## Prerequisites

- Install Wrangler (Cloudflare CLI)
- Authenticate:

```bash
wrangler login
```

If you run this from an environment that Wrangler considers non-interactive (common in CI or some editor terminals), you may need an API token:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
```

## Save logs to a file (JSONL)

### PowerShell (Windows)

```powershell
# If you have no wrangler.toml in this folder, pass your Worker name.
# Writes to ./worker.logs.jsonl (append)
./tail-logs.ps1 -Name "<worker-name>"

# Custom output file and env (only set -Env if you actually have [env.<name>] configured)
./tail-logs.ps1 -Name "<worker-name>" -OutFile worker.logs.jsonl -Env "<envName>"
```

### Bash (Git Bash / WSL / macOS / Linux)

```bash
chmod +x ./tail-logs.sh

# If you have no wrangler.toml in this folder, pass your Worker name.
# Writes to ./worker.logs.jsonl (append)
./tail-logs.sh worker.logs.jsonl '' "<worker-name>"

# Custom output file and env (only set env if you have [env.<name>] configured)
./tail-logs.sh worker.logs.jsonl "<envName>" "<worker-name>"
```

## Notes

- Output format is JSON Lines (one JSON object per line).
- Stop streaming with Ctrl+C.
- If you want to filter logs later, tools like `jq` work well.
