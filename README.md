# opencode-trace

This opencode plugin lets you see the raw json requests made to the LLM, and the responses. The output file is `${TRACE_FILENAME}.jsonl` in `TRACE_DIR`.

This opencode plugin is designed specifically for [FM-Agent](https://github.com/haoran-ding/FM-Agent).

# Usage

This plugin strictly requires the provision of two environment variables: `TRACE_DIR` and `TRACE_FILENAME`. If either of these variables is missing, the plugin will take no action.

If the directory cannot be created or the file cannot be written, the plugin will take no action.

If the file already exists, the plugin's default behavior is to overwrite it.

## Installation

Add the package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@lucentia/opencode-trace"]
}
```

That installation path by default uses `@latest`, which opencode currently does't refresh when latest changes. You can force a refresh with `rm -rf ~/.cache/opencode/packages/@lucentia/opencode-trace@latest`
