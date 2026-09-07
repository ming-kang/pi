export const BTW_WIDGET = "btw";
export const MAX_QUESTIONS = 24;
export const MAX_QUESTION_CHARS = 32_000;
export const MAX_MODEL_STEPS = 3;
export const MAX_OUTPUT_RESERVE_TOKENS = 32_768;
export const MAX_RESPONSE_CHARS = 512_000;
export const MAX_DISPLAY_CHARS = 64_000;
export const MAX_SNAPSHOT_CHARS = 16_000_000;

export const TOOL_DENIAL = "Tools are unavailable in this BTW conversation. Answer using the inherited context only.";
export const UNKNOWN_TOOL_RESULT =
	"This tool had not returned a result when the BTW context snapshot was captured. Its outcome is unknown here; the original task may still be running.";

// Append at the tail as a user message. Changing the system prompt or dropping
// tool definitions would invalidate the shared main-request cache prefix.
export const BTW_REMINDER = `<btw-reminder>
This is a separate side conversation about the preceding context. Answer the user's side questions without continuing or changing the original task. The original task may still be running; later activity is not part of this snapshot.
Tool definitions are retained for prompt-cache reuse, but tools cannot be executed here. Use only the available context, and say when it does not contain the answer.
This conversation is temporary: it is not added to the original conversation and is discarded when the user closes the BTW panel.
</btw-reminder>`;
