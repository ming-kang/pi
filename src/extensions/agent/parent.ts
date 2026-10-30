import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../core/extensions/types.ts";
import { TASK_MESSAGE_BYTES } from "../../core/tasks/output.ts";

const messageParentSchema = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Explicit information to push to the parent Agent" }),
	},
	{ additionalProperties: false },
);

/** The worker's half of the parent channel; `send` returns false when the parent cannot accept it. */
export function createMessageParentTool(
	send: (message: string) => boolean,
): ToolDefinition<typeof messageParentSchema> {
	return defineTool({
		name: "message_parent",
		label: "Message parent",
		description:
			"Push an explicit message to the parent Agent that delegated this task. Ordinary assistant text is only recorded for inspection and is not pushed. Use this for a significant finding, blocker, or decision that needs the parent's attention. This queues the message and returns without waiting for a reply; the parent may respond through steering.",
		promptSnippet: "Send the parent Agent an explicit message",
		promptGuidelines: [
			"Use message_parent sparingly for information that needs the parent's attention; routine progress belongs in ordinary assistant text.",
			"Do not wait for message_parent to return a reply. Continue useful work; any parent response arrives as a steering message.",
		],
		parameters: messageParentSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params) {
			const message = params.message.trim();
			if (!message || Buffer.byteLength(message) > TASK_MESSAGE_BYTES)
				throw new Error("Parent message must contain text and fit within 16 KiB.");
			const accepted = send(message);
			return {
				content: [
					{
						type: "text" as const,
						text: accepted
							? "Message queued for the parent Agent. No reply is awaited; continue useful work and watch for steering."
							: "The parent Agent cannot accept this message right now. Record the information in your report.",
					},
				],
				details: { accepted },
				...(accepted ? {} : { isError: true }),
			};
		},
	});
}
