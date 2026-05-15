# opencode-trace

This is a plugin designed to capture the raw JSON requests sent to the LLM, and the raw JSON responses back after streaming-delta consolidation. It writes pure JSONL for FM-Agent trace collection.
- End users should install it as an npm plugin via `"plugin": ["@lucentia/opencode-trace"]` in `~/.config/opencode/opencode.json`.
- Runtime requires both `TRACE_DIR` and `TRACE_FILENAME`. `TRACE_DIR` must be an absolute path. `TRACE_FILENAME` must be a basename without path separators; the plugin writes `${TRACE_FILENAME}.jsonl` inside `TRACE_DIR`.
- Missing or invalid environment variables, directory creation failures, and write failures are silent. The plugin must not interrupt OpenCode.
- Existing trace files are overwritten when this plugin instance first writes to them, then subsequent rows are appended.
- For development: `npm install` once, and change the plugin line to `["/path/to/opencode-trace/index.ts"]`. Then each time you edit, run `npm run typecheck` and `npm run lint`, then exercise it with something like `TRACE_DIR=/tmp TRACE_FILENAME=opencode-trace-test opencode run --dangerously-skip-permissions "why is the sky blue?"`. It uses the existing OpenCode configuration to pick up already-configured auth.
- To deploy, bump version, `npm login`, `npm publish --dry-run`, `npm publish`. Verify with `npm view "@lucentia/opencode-trace"`, then test it by installing as above.
