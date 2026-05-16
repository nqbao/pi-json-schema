# @nqbao/pi-json-schema

`@nqbao/pi-json-schema` is a Pi extension that enforces structured JSON output against a caller-provided JSON Schema.

It registers a `json_output` tool, validates the final payload with `ajv`, and writes the validated JSON to a file. If the tool is not called, it can optionally attempt one fallback extraction pass from the last assistant message.

## Install

Install the extension through Pi:

```bash
pi install npm:@nqbao/pi-json-schema
```

## Usage

After installation, the extension is available automatically:

```bash
pi -p "Extract company name and revenue from: Acme Corp reported 5 million dollars in revenue last quarter" \
  --json-schema '{"type":"object","properties":{"company":{"type":"string"},"revenue":{"type":"number"}},"required":["company","revenue"]}' \
  --json-output /tmp/result.json
```

Expected output file:

```json
{
  "company": "Acme Corp",
  "revenue": 5000000
}
```

## Flags

- `--json-schema`: JSON Schema string that the final output must satisfy.
- `--json-output`: file path where validated JSON will be written.
- `--json-fallback`: fallback behavior when `json_output` was not called.

Fallback modes:

- `best-effort`: try one follow-up extraction pass with the configured model. This is the default.
- `force`: same as `best-effort`, but forces the follow-up model call to choose `json_output`.
- `none`: do not attempt fallback; fail if the final assistant message does not contain valid JSON.

## Behavior

- If `--json-output` is not set, the extension stays inactive.
- If `--json-output` is set, `--json-schema` is required.
- The agent is expected to call `json_output` as its last action.
- If the tool was not called, the extension first checks whether the last assistant message already contains valid JSON.
- If there is no assistant message at all, the extension does nothing during shutdown and leaves the upstream run failure unchanged.

## Local Development

When working in this repo directly, load the extension from the local file instead of the installed package name:

```bash
pi -p "Extract company name and revenue from: Acme Corp reported 5 million dollars in revenue last quarter" \
  --extension ./index.ts \
  --json-schema '{"type":"object","properties":{"company":{"type":"string"},"revenue":{"type":"number"}},"required":["company","revenue"]}' \
  --json-output /tmp/result.json
```

Install dependencies:

```bash
npm install
```

Run the existing end-to-end test harness:

```bash
bash test/run.sh
```

Test prerequisites:

- `pi` must be installed and available on `PATH`.
- model/API credentials must already be configured for Pi.
- `jq` must be installed.

