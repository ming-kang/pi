import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../core/extensions/types.ts";
import { TASK_MESSAGE_BYTES } from "../../core/tasks/output.ts";

const supervisorSchema = Type.Object(
	{
		message: Type.String({ minLength: 1, description: "Explicit information to push to the parent Agent" }),
	},
	{ additionalProperties: false },
);

export function createSupervisorTool(send: (message: string) => boolean): ToolDefinition<typeof supervisorSchema> {
	return defineTool({
		name: "contact_supervisor",
		label: "Contact supervisor",
		description:
			"Push an explicit message to the parent Agent. Ordinary assistant text is only recorded for inspection and is not pushed. Use this for a significant finding, blocker, or decision that needs the caller's attention. This queues the message and returns without waiting for a reply; the parent may respond through steering.",
		promptSnippet: "Send the parent Agent an explicit message",
		promptGuidelines: [
			"Use contact_supervisor sparingly for information that needs the parent's attention; routine progress belongs in ordinary assistant text.",
			"Do not wait for contact_supervisor to return a reply. Continue useful work; any parent response arrives as a steering message.",
		],
		parameters: supervisorSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params) {
			const message = params.message.trim();
			if (!message || Buffer.byteLength(message) > TASK_MESSAGE_BYTES)
				throw new Error("Supervisor message must contain text and fit within 16 KiB.");
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
