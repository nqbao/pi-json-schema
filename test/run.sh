#!/usr/bin/env bash
set -uo pipefail

EXTENSION="$(cd "$(dirname "$0")/.." && pwd)/index.ts"
OUTPUT="/tmp/pi-json-schema-test.json"
PASS=0
FAIL=0
MODEL="${MODEL:-}"

# Colors
GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1"; echo "     $2"; FAIL=$((FAIL + 1)); }

run() {
  local desc="$1"; shift
  rm -f "$OUTPUT"
  pi -p "$@" \
    ${MODEL:+--model "$MODEL"} \
    --extension "$EXTENSION" \
    --json-output "$OUTPUT" \
    2>/dev/null || true
}

assert_field() {
  local field="$1"
  local expected="$2"
  local actual
  actual=$(jq -r "$field" "$OUTPUT" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    return 0
  else
    echo "     field $field: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

assert_file_exists() {
  [[ -f "$OUTPUT" ]] && jq . "$OUTPUT" > /dev/null 2>&1
}

echo ""
echo "=== pi-json-schema e2e tests ==="
echo ""

# ─── Test 1: simple inline extraction (normal path) ──────────────────────────
DESC="simple inline extraction"
run "$DESC" \
  "Extract company name and revenue from: Acme Corp reported 5 million dollars in revenue last quarter" \
  --json-schema '{"type":"object","properties":{"company":{"type":"string"},"revenue":{"type":"number"}},"required":["company","revenue"]}'

if assert_file_exists && \
   assert_field '.company' 'Acme Corp' && \
   assert_field '.revenue' '5000000'; then
  pass "$DESC"
else
  fail "$DESC" "$(cat "$OUTPUT" 2>/dev/null || echo 'no output file')"
fi

# ─── Test 2: read file then extract (fallback path) ──────────────────────────
DESC="read file + extract (fallback)"
FIXTURE="$(dirname "$0")/fixtures/article.txt"
run "$DESC" \
  "Read $FIXTURE then extract the company name, revenue in dollars, and employee count" \
  --json-schema '{"type":"object","properties":{"company":{"type":"string"},"revenue":{"type":"number"},"employees":{"type":"number"}},"required":["company","revenue","employees"]}'

if assert_file_exists && \
   assert_field '.company' 'TechCorp' && \
   [[ "$(jq '.revenue' "$OUTPUT" 2>/dev/null)" =~ ^[0-9]+(\.[0-9]+)?$ ]] && \
   [[ "$(jq '.employees' "$OUTPUT" 2>/dev/null)" =~ ^[0-9]+$ ]]; then
  pass "$DESC"
else
  fail "$DESC" "$(cat "$OUTPUT" 2>/dev/null || echo 'no output file')"
fi

# ─── Test 3: nested schema ───────────────────────────────────────────────────
DESC="nested schema"
run "$DESC" \
  "Parse this address: 123 Main St, Springfield, IL 62701" \
  --json-schema '{"type":"object","properties":{"street":{"type":"string"},"city":{"type":"string"},"state":{"type":"string"},"zip":{"type":"string"}},"required":["street","city","state","zip"]}'

if assert_file_exists && \
   assert_field '.city' 'Springfield' && \
   assert_field '.state' 'IL'; then
  pass "$DESC"
else
  fail "$DESC" "$(cat "$OUTPUT" 2>/dev/null || echo 'no output file')"
fi

# ─── Test 4: array output ────────────────────────────────────────────────────
DESC="array of items"
run "$DESC" \
  "Extract all people mentioned: Alice is 30, Bob is 25, Carol is 35" \
  --json-schema '{"type":"object","properties":{"people":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}},"required":["name","age"]}}},"required":["people"]}'

PEOPLE_COUNT=$(jq '.people | length' "$OUTPUT" 2>/dev/null || echo 0)
if assert_file_exists && [[ "$PEOPLE_COUNT" -eq 3 ]]; then
  pass "$DESC"
else
  fail "$DESC" "expected 3 people, got $PEOPLE_COUNT — $(cat "$OUTPUT" 2>/dev/null || echo 'no output file')"
fi

# ─── Test 5: missing --json-schema exits non-zero ────────────────────────────
DESC="missing --json-schema exits non-zero"
rm -f "$OUTPUT"
pi -p "hello" \
  ${MODEL:+--model "$MODEL"} \
  --extension "$EXTENSION" \
  --json-output "$OUTPUT" \
  2>/dev/null
EXIT=$?
if [[ "$EXIT" -ne 0 ]] && [[ ! -f "$OUTPUT" ]]; then
  pass "$DESC"
else
  fail "$DESC" "expected non-zero exit and no output file, got exit=$EXIT"
fi

# ─── Test 6: invalid --json-schema exits non-zero ────────────────────────────
DESC="invalid --json-schema exits non-zero"
rm -f "$OUTPUT"
pi -p "hello" \
  ${MODEL:+--model "$MODEL"} \
  --extension "$EXTENSION" \
  --json-schema 'not valid json' \
  --json-output "$OUTPUT" \
  2>/dev/null
EXIT=$?
if [[ "$EXIT" -ne 0 ]] && [[ ! -f "$OUTPUT" ]]; then
  pass "$DESC"
else
  fail "$DESC" "expected non-zero exit and no output file, got exit=$EXIT"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
printf "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}\n"
echo ""
[[ "$FAIL" -eq 0 ]]
