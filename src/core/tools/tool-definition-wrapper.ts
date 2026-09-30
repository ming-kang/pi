import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { truncateHead } from "./truncate.ts";

export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

const RECEIVED_ARGUMENTS_MARKER = "\n\nReceived arguments:\n";
const HINT_MARKER = "\n\nHint: ";
const RECEIVED_ARGUMENTS_MAX_BYTES = 2 * 1024;
const RECEIVED_ARGUMENTS_MAX_LINES = 40;
const FIELD_HINTS_MAX = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walk schema and arguments in sync to name, at every object with
 * `additionalProperties: false`, the non-null fields the schema does not
 * declare, and at every object, the required fields the arguments lack. The
 * validator's own report says where validation failed; these hints say what
 * the legal shape is. Union variants (`anyOf`, e.g. a nullable field) are
 * walked through so nested shapes still get hints. Paths use the validator's
 * dotted style
 * (`tasks[0].prompt`). Non-null unknown fields are reported rather than
 * silently dropped: a field like `prompt_extra` may carry briefing content
 * the caller intended to send.
 */
function collectFieldHints(schema: unknown, args: unknown): string[] {
	const hints: string[] = [];
	const visit = (node: unknown, value: unknown, path: string): void => {
		if (hints.length >= FIELD_HINTS_MAX || !isRecord(node)) return;
		if (Array.isArray(node.anyOf)) {
			// Only nullable single-shape unions have unambiguous field requirements.
			// Alternative object shapes must not contribute contradictory hints.
			const variants = node.anyOf.filter((variant: unknown) => !isRecord(variant) || variant.type !== "null");
			if (value !== null && variants.length === 1) visit(variants[0], value, path);
			return;
		}
		if (node.type === "array" && Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				visit(node.items, value[index], `${path}[${index}]`);
			}
			return;
		}
		if (node.type !== "object" || !isRecord(value)) return;
		const properties = isRecord(node.properties) ? node.properties : {};
		const fields = Object.keys(properties);
		const where = path || "root";
		if (node.additionalProperties === false) {
			for (const [key, entry] of Object.entries(value)) {
				if (entry !== null && !(key in properties) && hints.length < FIELD_HINTS_MAX) {
					const subject = path ? `${path}.${key}` : key;
					hints.push(`${subject} is not a field; fields at ${where}: ${fields.join(", ")}`);
				}
			}
		}
		if (Array.isArray(node.required)) {
			for (const key of node.required) {
				if (typeof key === "string" && value[key] === undefined && hints.length < FIELD_HINTS_MAX) {
					const subject = path ? `${path}.${key}` : key;
					hints.push(`${subject} is required; fields at ${where}: ${fields.join(", ")}`);
				}
			}
		}
		for (const key of fields) {
			if (value[key] !== undefined && value[key] !== null) {
				visit(properties[key], value[key], path ? `${path}.${key}` : key);
			}
		}
	};
	visit(schema, args, "");
	return hints;
}

/**
 * Rebuild pi-ai's validation error so a model can self-correct: the legal
 * fields are named next to each offending one, and the echoed arguments are
 * bounded (a 50KB tool argument must not be reflected whole into context).
 * The `Validation failed for tool "<name>":` prefix stays intact — the
 * question tool's renderer parses it.
 */
function enrichValidationError(error: unknown, parameters: TSchema, args: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	// A definition synthesized from an already-wrapped tool enriches on the
	// inside; do not stack a second layer of hints on the same failure.
	if (message.includes(HINT_MARKER)) return error instanceof Error ? error : new Error(message);
	const hints = collectFieldHints(parameters, args);
	const markerIndex = message.indexOf(RECEIVED_ARGUMENTS_MARKER);
	const head = markerIndex === -1 ? message : message.slice(0, markerIndex);
	const received = markerIndex === -1 ? "" : message.slice(markerIndex + RECEIVED_ARGUMENTS_MARKER.length);
	let enriched = hints.length > 0 ? `${head}\n\nHint: ${hints.join("\nHint: ")}` : head;
	if (markerIndex !== -1) {
		const bounded = truncateHead(received, {
			maxBytes: RECEIVED_ARGUMENTS_MAX_BYTES,
			maxLines: RECEIVED_ARGUMENTS_MAX_LINES,
		});
		enriched += `${RECEIVED_ARGUMENTS_MARKER}${bounded.content}`;
		if (bounded.truncated) enriched += "\n… (arguments truncated)";
	}
	return new Error(enriched);
}

/**
 * Pre-validate prepared arguments so a validation failure reaches the model
 * with field-level hints. Valid arguments pass through untouched and are
 * validated again by the agent loop as before.
 */
function wrapPrepareArguments<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
): (raw: unknown) => Static<TParams> {
	const tool = { name: definition.name, description: definition.description, parameters: definition.parameters };
	return (raw: unknown): Static<TParams> => {
		const args = definition.prepareArguments ? definition.prepareArguments(raw) : raw;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "",
				name: definition.name,
				arguments: args as JsonObject,
			});
		} catch (error) {
			throw enrichValidationError(error, definition.parameters, args);
		}
		return args as Static<TParams>;
	};
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TParams extends TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParams, TDetails>,
	ctxFactory?: ToolContextFactory,
): AgentTool<TParams, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: wrapPrepareArguments(definition),
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx ?? (ctxFactory?.(toolCallId, signal) as ExtensionToolContext),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool<TParams extends TSchema, TDetails>(
	tool: AgentTool<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
