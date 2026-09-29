# Run local System One models

This guide sets up two local models, Kev and Laya, and points claude-jev at one of them. It is step by step. A copy-paste prompt for an AI agent is at the end.

## What this sets up

- [Kev](https://github.com/jaredpalmer/kev) and [Laya](https://github.com/NandhaKishorM/laya) are third-party, Apache-2.0, open-weight models. TypeSafe does not serve or review them.
- The code comes from their GitHub repositories and runs on your machine.
- The weights come from Hugging Face on first start.
- Both servers answer `POST /v1/systemone` with the TypeSafe System One contract, so claude-jev can use either one.
- Judgment requests stay on your machine and TypeSafe does not bill them.

## Requirements

- OS: macOS on Apple Silicon is the tested setup (Apple M1 Max, 2026-09-29). Linux with CUDA or CPU should work but is untested.
- Disk: about 5 GB. The Kev repository and virtual environment take 1.9 GB, Laya takes 0.8 GB, and the Hugging Face cache takes about 2.5 GB.
- RAM: tested with 32 GB and the smallest checkpoints. Larger checkpoints need more.
- Tools: `uv`, `git`, `curl`, and Node.js 22.6 or newer for claude-jev 0.2.0 or newer.
- Network: needed for the clones, the Python packages, and the first weight download.

## Step by step

### 1. Choose an install root

The layout is `kev/`, `laya/`, `bin/`, and `logs/` under one directory. The default is `~/.local/share/systemone`. Set `SYSTEMONE_HOME` to use another location. Keep it set in every shell that runs the helper scripts.

```bash
export SYSTEMONE_HOME="${SYSTEMONE_HOME:-$HOME/.local/share/systemone}"
mkdir -p "$SYSTEMONE_HOME"/{bin,logs}
```

### 2. Install uv

Skip this step if `uv --version` works. On macOS with Homebrew:

```bash
brew install uv
```

Official installer for any platform:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 3. Clone and pin both repositories

These are the commits that were tested. Newer commits may work, but you use them at your own risk.

```bash
git clone https://github.com/jaredpalmer/kev "$SYSTEMONE_HOME/kev"
git -C "$SYSTEMONE_HOME/kev" checkout 0c142becde423a0c68ec857f7831dac0315588a1

git clone https://github.com/NandhaKishorM/laya "$SYSTEMONE_HOME/laya"
git -C "$SYSTEMONE_HOME/laya" checkout 9d955671415fc19f069b9cc998928075c1f255ec
```

The Laya commit is v0.3.21.

### 4. Create the environments

```bash
(cd "$SYSTEMONE_HOME/kev" && uv sync --extra serve)
(cd "$SYSTEMONE_HOME/laya" && uv venv && uv pip install -e ".[serve]")
```

### 5. Write the helper scripts

Each block creates one script in `$SYSTEMONE_HOME/bin` and makes it executable. The scripts use `SYSTEMONE_HOME` when set and the default root otherwise. Both servers bind to `127.0.0.1`.

Kev start. Set `KEV_RUN` to use a larger checkpoint (`jaredpalmer/kev-4b`, `kev-9b`, or `kev-27b`) and `KEV_PORT` to change the port.

```bash
cat > "$SYSTEMONE_HOME/bin/kev-start" <<'EOF_KEV_START'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${SYSTEMONE_HOME:-$HOME/.local/share/systemone}"
PORT="${KEV_PORT:-8009}"
RUN="${KEV_RUN:-jaredpalmer/kev-0.8b}"
PIDFILE="$ROOT/logs/kev.pid"
mkdir -p "$ROOT/logs"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "kev already running (pid $(cat "$PIDFILE"))"
  exit 0
fi
cd "$ROOT/kev"
nohup uv run --extra serve python -m kev.serve --run "$RUN" --host 127.0.0.1 --port "$PORT" \
  >>"$ROOT/logs/kev.log" 2>&1 &
echo $! > "$PIDFILE"
echo "kev starting on 127.0.0.1:$PORT (pid $!), log: $ROOT/logs/kev.log"
EOF_KEV_START
chmod +x "$SYSTEMONE_HOME/bin/kev-start"
```

Kev stop:

```bash
cat > "$SYSTEMONE_HOME/bin/kev-stop" <<'EOF_KEV_STOP'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${SYSTEMONE_HOME:-$HOME/.local/share/systemone}"
PIDFILE="$ROOT/logs/kev.pid"
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    echo "kev stopped"
  else
    echo "kev not running"
  fi
  rm -f "$PIDFILE"
else
  echo "kev not running"
fi
EOF_KEV_STOP
chmod +x "$SYSTEMONE_HOME/bin/kev-stop"
```

Laya start. `LAYA_DEVICE` defaults to `mps` on Apple Silicon, `cuda` when `nvidia-smi` exists, and `cpu` otherwise. Override it with the environment variable. `LAYA_MODELS` picks the checkpoint (`english`, `multilingual`, or `typed-decisions`). `LAYA_HOST=127.0.0.1` is required because Laya binds `0.0.0.0` by default.

```bash
cat > "$SYSTEMONE_HOME/bin/laya-start" <<'EOF_LAYA_START'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${SYSTEMONE_HOME:-$HOME/.local/share/systemone}"
PORT="${LAYA_PORT:-8000}"
MODELS="${LAYA_MODELS:-english}"
PIDFILE="$ROOT/logs/laya.pid"
if [ -z "${LAYA_DEVICE:-}" ]; then
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    LAYA_DEVICE=mps
  elif command -v nvidia-smi >/dev/null 2>&1; then
    LAYA_DEVICE=cuda
  else
    LAYA_DEVICE=cpu
  fi
fi
mkdir -p "$ROOT/logs"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "laya already running (pid $(cat "$PIDFILE"))"
  exit 0
fi
cd "$ROOT/laya"
LAYA_HOST=127.0.0.1 LAYA_PORT="$PORT" LAYA_DEVICE="$LAYA_DEVICE" LAYA_PRELOAD=1 LAYA_MODELS="$MODELS" \
  nohup .venv/bin/laya-serve >>"$ROOT/logs/laya.log" 2>&1 &
echo $! > "$PIDFILE"
echo "laya starting on 127.0.0.1:$PORT, device $LAYA_DEVICE (pid $!), log: $ROOT/logs/laya.log"
EOF_LAYA_START
chmod +x "$SYSTEMONE_HOME/bin/laya-start"
```

Laya stop:

```bash
cat > "$SYSTEMONE_HOME/bin/laya-stop" <<'EOF_LAYA_STOP'
#!/usr/bin/env bash
set -euo pipefail
ROOT="${SYSTEMONE_HOME:-$HOME/.local/share/systemone}"
PIDFILE="$ROOT/logs/laya.pid"
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}
if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid"
    echo "laya stopped"
  else
    echo "laya not running"
  fi
  rm -f "$PIDFILE"
else
  echo "laya not running"
fi
EOF_LAYA_STOP
chmod +x "$SYSTEMONE_HOME/bin/laya-stop"
```

Status. It calls each health endpoint and prints `up` or `down`.

```bash
cat > "$SYSTEMONE_HOME/bin/systemone-status" <<'EOF_STATUS'
#!/usr/bin/env bash
set -uo pipefail
KEV_PORT="${KEV_PORT:-8009}"
LAYA_PORT="${LAYA_PORT:-8000}"
if curl -fsS -m 3 "http://127.0.0.1:$KEV_PORT/v1/models" >/dev/null 2>&1; then
  echo "kev  up   http://127.0.0.1:$KEV_PORT/v1/systemone"
else
  echo "kev  down"
fi
if curl -fsS -m 3 "http://127.0.0.1:$LAYA_PORT/health" >/dev/null 2>&1; then
  echo "laya up   http://127.0.0.1:$LAYA_PORT/v1/systemone"
else
  echo "laya down"
fi
EOF_STATUS
chmod +x "$SYSTEMONE_HOME/bin/systemone-status"
```

Add the scripts to your PATH for the current shell, or call them by full path:

```bash
export PATH="$SYSTEMONE_HOME/bin:$PATH"
```

### 6. Start both servers

You need only one server, but starting both lets you compare them. The first start takes 1 to 2 minutes because it downloads and loads the weights. Kev downloads the 63 MB adapter and the 1.6 GB base model Qwen/Qwen3.5-0.8B-Base. Laya downloads the 807 MB `english` checkpoint from `convaiinnovations/laya`. On Apple Silicon Kev uses the MLX backend on the GPU automatically.

```bash
kev-start
laya-start
```

Wait for both to answer. This loop gives up after 5 minutes:

```bash
for i in $(seq 1 100); do
  if curl -fsS -m 3 http://127.0.0.1:8009/v1/models >/dev/null 2>&1 \
     && curl -fsS -m 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then
    echo "both up"; break
  fi
  [ "$i" = 100 ] && echo "timeout, see $SYSTEMONE_HOME/logs" >&2
  sleep 3
done
systemone-status
```

### 7. Send a direct request

This request works on both servers. Change the port to 8000 for Laya.

```bash
cat > /tmp/systemone-request.json <<'JSON'
{
  "state": {"message": "My order is three weeks late and nobody answers my emails. Fix this today."},
  "questions": {
    "urgent": {"type": "noul", "instructions": "Does this need urgent human attention?"},
    "frustration": {"type": "score", "instructions": "How frustrated is the customer?", "criteria": ["Calm", "Frustrated", "Very angry"]},
    "team": {"type": "choice", "instructions": "Which team should handle this?", "criteria": {"billing": "Payments and invoices", "shipping": "Delivery and tracking", "support": "General help"}}
  }
}
JSON
node -e '
const request = JSON.parse(require("fs").readFileSync(0, "utf8"));
request.model = process.argv[1];
console.log(JSON.stringify(request));
' kev-latest < /tmp/systemone-request.json \
  | curl -sS -m 30 http://127.0.0.1:8009/v1/systemone \
      -H 'Content-Type: application/json' -d @-
```

The file holds only `state` and `questions`, which is what `claude-jev ask` accepts. The `node` command adds the `model` field for curl. For Laya, replace `kev-latest` with `english` and use `http://127.0.0.1:8000/v1/systemone`. The response has an `answers` object with one typed answer for each question.

### 8. Point claude-jev at a server

`model` and `endpoint` are read only from the global file `~/.claude/claude-jev.json`. Project configuration cannot set them. This command merges the two keys into that file, keeps every other key, and creates the file if it is missing. It stops without writing if the existing file is not valid JSON.

For Kev:

```bash
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const file = path.join(os.homedir(), ".claude", "claude-jev.json");
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
config.model = process.argv[1];
config.endpoint = process.argv[2];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' kev-latest http://127.0.0.1:8009/v1/systemone
```

For Laya, replace the two arguments on the last line with `english http://127.0.0.1:8000/v1/systemone`.

claude-jev 0.2.0 and newer treat `localhost`, `127.x.x.x`, and `[::1]` as local endpoints. A local endpoint can use plain `http`, needs no TypeSafe key, never receives `TYPESAFE_API_KEY`, and skips the model-family check.

If you start a server with `KEV_API_KEY` or `LAYA_API_KEY`, save the same key in a file (for example `~/.claude/local-model.key`, mode 600) and add `"apiKeyFile": "local-model.key"` to the config. A relative path resolves under `~/.claude`. Neither server sets a key in this guide.

### 9. Verify with claude-jev

```bash
claude-jev ask < /tmp/systemone-request.json
claude-jev status
```

`claude-jev ask` prints JSON with a validated `answers` object. `claude-jev status` should print `Endpoint: local`. Measured on the tested machine: a warm direct request took about 50 ms on Kev and 60 to 80 ms on Laya. The full `claude-jev ask` command took about 255 ms, mostly Node startup.

## Daily use

Start the server before a Claude Code session and stop it afterward.

```bash
kev-start        # or laya-start
systemone-status
kev-stop         # or laya-stop
```

Hooks fail open. When the server is down, tool calls still run and receive no judgment.

## Switch models

- To switch between Kev and Laya, run step 8 again with the other model and endpoint.
- To use a larger Kev checkpoint, run `kev-stop`, then `KEV_RUN=jaredpalmer/kev-4b kev-start`. The config stays `kev-latest`.
- To use another Laya checkpoint, run `laya-stop`, then `LAYA_MODELS=multilingual laya-start`. Set `model` in the config to the same name.
- To return to TypeSafe hosted Jev, remove `endpoint` from `~/.claude/claude-jev.json` and set `model` to `jev-latest`. You can also remove both keys. Hosted Jev needs `TYPESAFE_API_KEY`.

## Uninstall

```bash
kev-stop
laya-stop
rm -rf "$SYSTEMONE_HOME"
```

Optional: remove the downloaded weights. The paths below assume the default Hugging Face cache. Adjust them if you set `HF_HOME`. The Qwen base model may be shared with other tools, so check before you delete it.

```bash
rm -rf ~/.cache/huggingface/hub/models--jaredpalmer--kev-0.8b
rm -rf ~/.cache/huggingface/hub/models--Qwen--Qwen3.5-0.8B-Base
rm -rf ~/.cache/huggingface/hub/models--convaiinnovations--laya
```

Then delete the `endpoint` and `model` keys from `~/.claude/claude-jev.json`, or set `model` back to `jev-latest`.

## Troubleshooting

- First start is slow. The server downloads and loads weights, which takes 1 to 2 minutes. Watch `$SYSTEMONE_HOME/logs/kev.log` or `laya.log`.
- Port in use. Run `lsof -i :8009` (Kev) or `lsof -i :8000` (Laya). Stop the other process or set `KEV_PORT` or `LAYA_PORT`. If you change a port, change the endpoint in the config too.
- Laya fails on the GPU. Retry with `LAYA_DEVICE=cpu laya-start`.
- Server is down. Hooks fail open and `claude-jev ask` exits with code 1. Run `systemone-status`, then check the log.
- HTTP 401. The server has an API key set. Put the same key in a file and reference it as `apiKeyFile` in `~/.claude/claude-jev.json`.
- Logs. `$SYSTEMONE_HOME/logs/` holds `kev.log`, `laya.log`, and the pid files.

## Security notes

- Keep both servers on `127.0.0.1`. Do not expose the ports to a network or forward them. Laya binds `0.0.0.0` unless `LAYA_HOST=127.0.0.1` is set, and the helper script sets it.
- Kev and Laya are third-party code, and their weights come from Hugging Face. Neither TypeSafe nor this plugin reviews them.
- Pin the commits from step 3. Review the diff before you move to a newer commit.
- Do not run either server with `sudo`.
- The hooks send bounded commands, file content, and output to the local server. This data stays on your machine.

## Prompt for an AI agent

Copy this into Claude Code or another coding agent.

```text
Set up a local System One model server for claude-jev and configure claude-jev to use it.

Guide: read and follow the local models guide. If claude-jev is installed as a plugin, it is at ${CLAUDE_PLUGIN_ROOT}/docs/local-models.md; when that variable is not set, find it with: ls ~/.claude/plugins/cache/*/claude-jev/*/docs/local-models.md (use the highest version). In the claude-jev repository, it is docs/local-models.md. Use the commands from that guide. Do not invent other commands.

First, ask me which model to set up: Kev or Laya. Wait for my answer.

Constraints:
- Do not use sudo.
- Ask me before installing uv. Ask me before downloading about 5 GB of repositories, packages, and model weights.
- Bind servers to 127.0.0.1 only. Never expose a port.
- Edit only the "model" and "endpoint" keys in ~/.claude/claude-jev.json. Keep every other key. Create the file if it is missing. If it is not valid JSON, stop and tell me.
- Do not print secrets or API keys.
- If any step fails, stop and report the error. Do not try risky fixes, such as changing permissions, deleting directories outside the install root, or using unpinned commits.

Steps:
1. Check for uv, git, curl, and node 22.6 or newer. Report what is missing.
2. Set SYSTEMONE_HOME (default ~/.local/share/systemone).
3. Install uv only after I approve.
4. Clone the repository for my chosen model and check out the pinned commit from the guide. Clone both if I ask for both.
5. Create the environment for each cloned repository.
6. Write the helper scripts from the guide into $SYSTEMONE_HOME/bin.
7. Start the server with kev-start or laya-start. Wait for health with the bounded loop from the guide.
8. Send the direct curl request from the guide.
9. Merge model and endpoint into ~/.claude/claude-jev.json using the guide's command:
   Kev: model kev-latest, endpoint http://127.0.0.1:8009/v1/systemone
   Laya: model english, endpoint http://127.0.0.1:8000/v1/systemone
10. Run claude-jev ask with the verification request, and run claude-jev status. Status must show "Endpoint: local".

Report back:
- install root and the paths of the cloned repositories
- the commit of each repository
- disk used by the install root and the Hugging Face cache
- the device used (mps, cuda, or cpu)
- the output of the direct curl request and of claude-jev ask
- how to start and stop the server
```
