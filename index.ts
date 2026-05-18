import { writeFileSync } from "fs";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function structuredOutputExtension(pi: ExtensionAPI) {
	const ajv = new Ajv({ allErrors: true, strict: false });

	pi.registerFlag("json-schema", {
		description: "JSON Schema the agent must conform to when calling json_output.",
		type: "string",
	});

	pi.registerFlag("json-output", {
		description: "File path to write the structured JSON output to.",
		type: "string",
	});

	pi.registerFlag("json-fallback", {
		description: "Fallback mode when json_output tool was not called: 'none' (no fallback), 'force' (force tool choice), 'best-effort' (one more turn, fail if no JSON found). Defaults to 'best-effort'.",
		type: "string",
	});

	let schema: Record<string, unknown> | null = null;
	let outputPath: string | null = null;
	let toolCalled = false;
	let validateOutput: ValidateFunction<Record<string, unknown>> | null = null;

	const resetSessionState = () => {
		schema = null;
		outputPath = null;
		toolCalled = false;
		validateOutput = null;
	};

	const writeOutput = (data: Record<string, unknown>) => {
		writeFileSync(outputPath!, JSON.stringify(data, null, 2) + "\n", "utf8");
	};

	const fail = (message: string) => {
		process.stderr.write(`pi-json-schema: ${message}\n`);
		process.exit(1);
	};

	const validateAndWriteOutput = (data: Record<string, unknown>, source: string) => {
		if (!validateOutput) {
			fail(`schema validator unavailable while processing ${source}`);
		}

		if (!validateOutput(data)) {
			const details = ajv.errorsText(validateOutput.errors, { separator: "; " });
			fail(`${source} did not conform to schema${details ? `: ${details}` : ""}`);
		}

		writeOutput(data);
	};

	const tryExtractJson = (text: string): Record<string, unknown> | null => {
		try {
			return JSON.parse(text.trim()) as Record<string, unknown>;
		} catch {
			// fall through
		}

		const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
		if (codeBlockMatch) {
			try {
				return JSON.parse(codeBlockMatch[1]) as Record<string, unknown>;
			} catch {
				// fall through
			}
		}

		const rawMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
		if (rawMatch) {
			try {
				return JSON.parse(rawMatch[1]) as Record<string, unknown>;
			} catch {
				// fall through
			}
		}

		return null;
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState();

		const rawSchema = pi.getFlag("json-schema");
		const rawOutput = pi.getFlag("json-output");

		if (typeof rawOutput !== "string" || !rawOutput) return;
		outputPath = rawOutput;

		if (typeof rawSchema !== "string" || !rawSchema) {
			fail("--json-schema is required when using --json-output");
		}

		try {
			schema = JSON.parse(rawSchema) as Record<string, unknown>;
		} catch {
			fail("--json-schema is not valid JSON");
		}

		try {
			validateOutput = ajv.compile<Record<string, unknown>>(schema);
		} catch (error) {
			fail(`--json-schema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
		}

		pi.registerTool({
			name: "json_output",
			label: "Structured Output",
			description:
				"Return a final structured answer conforming to the JSON schema specified at session start. Use this as your last action.",
			promptSnippet: "Emit structured output conforming to the provided JSON schema as a terminating action",
			promptGuidelines: [
				"Always call json_output as your final action when the task is complete.",
				"The arguments you pass must strictly conform to the JSON schema provided at session start.",
				"Do not emit any further assistant response after calling json_output.",
			],
			parameters: Type.Unsafe<Record<string, unknown>>(schema),
			async execute(_toolCallId, params) {
				validateAndWriteOutput(params as Record<string, unknown>, "json_output tool arguments");
				toolCalled = true;
				return {
					content: [{ type: "text", text: JSON.stringify(params, null, 2) }],
					terminate: true,
				};
			},
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const fallbackMode = pi.getFlag("json-fallback") ?? "best-effort";
			if (!["best-effort", "force", "none"].includes(String(fallbackMode))) {
				fail(`invalid --json-fallback value "${fallbackMode}". Valid: best-effort, force, none`);
			}
			if (toolCalled || !schema || !outputPath) return;

			const entries = ctx.sessionManager?.getEntries();
			if (!entries) return;
			let lastOutput = "";
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; message?: { role?: string; content?: unknown } };
				if (entry.type === "message" && entry.message?.role === "assistant") {
					const content = entry.message.content;
					if (Array.isArray(content)) {
						lastOutput = content
							.filter((c): c is { type: "text"; text: string } => c?.type === "text")
							.map((c) => c.text)
							.join("\n");
					}
					break;
				}
			}

			if (!lastOutput.trim()) {
				return;
			}

			// Check if last output is already JSON
			let result = tryExtractJson(lastOutput);
			if (result) {
				validateAndWriteOutput(result, "assistant message JSON");
				return;
			}

			// Not JSON — check fallback mode
			if (fallbackMode === "none") {
				fail("json_output tool was not called and no JSON found in last message");
			}

			const model = ctx.model;
			if (!model) {
				fail("fallback failed - no model available");
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				fail("fallback failed - could not retrieve API credentials");
			}

			let response;
			try {
				response = await complete(
					model,
					{
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text: `Extract structured data from the following text and call the json_output tool:\n\n${lastOutput}`,
									},
								],
								timestamp: Date.now(),
							},
						],
						tools: [
							{
								name: "json_output",
								description: "Return structured data extracted from the text.",
								parameters: Type.Unsafe(schema),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						...(fallbackMode === "force" ? { tool_choice: { type: "tool", name: "json_output" } } : {}),
					},
				);
			} catch (err) {
				fail(`fallback failed - LLM call error: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Last output = LLM response (tool call args or text)
			const toolCall = response.content.find(
				(c): c is { type: "toolCall"; name: string; arguments: Record<string, unknown> } =>
					(c as { type: string }).type === "toolCall",
			);
	
			lastOutput = toolCall
				? JSON.stringify(toolCall.arguments)
				: response.content
					.filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
					.map((c) => c.text)
					.join("\n");

			// Check last output one more time
			result = tryExtractJson(lastOutput);
			if (result) {
				validateAndWriteOutput(result, "fallback JSON");
				return;
			}

			fail("fallback failed - no JSON found in model response");
		} finally {
			resetSessionState();
		}
	});
}
