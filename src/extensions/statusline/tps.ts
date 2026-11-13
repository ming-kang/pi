import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";

/** Shortest window and fewest tokens that can carry a rate, live or settled. */
export const TPS_MIN_WINDOW_MS = 250;
export const TPS_MIN_TOKENS = 2;
export const TPS_LIVE_UPDATE_INTERVAL_MS = 200;
const MAX_OBSERVED_MESSAGES = 64;
const MAX_RELOAD_SNAPSHOTS = 16;

interface TokenEstimate {
	cjkChars: number;
	otherChars: number;
}

interface ActiveStream extends TokenEstimate {
	firstDeltaAt?: number;
	/** Estimated tokens of the delta that opened the window. They arrived over no measured time. */
	openingTokens: number;
	lastRenderRequestAt?: number;
}

/** How the stream of one finished response arrived. Kept apart from the message, whose usage can still change. */
interface StreamObservation {
	/** First delta until the message ended. Zero when nothing streamed. */
	windowMs: number;
	/** Estimated tokens across all deltas. */
	tokens: number;
	openingTokens: number;
}

const reloadSnapshots = new Map<string, Map<string, StreamObservation>>();

function rate(tokens: number, ms: number): number | undefined {
	return ms >= TPS_MIN_WINDOW_MS && tokens >= TPS_MIN_TOKENS ? tokens / (ms / 1000) : undefined;
}

function messageSignature(message: Pick<AssistantMessage, "timestamp" | "provider" | "model">): string {
	return `${message.timestamp}:${message.provider}:${message.model}`;
}

function addCharCounts(target: TokenEstimate, text: string): void {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (
			(code >= 0x3000 && code <= 0x30ff) ||
			(code >= 0x3400 && code <= 0x9fff) ||
			(code >= 0xac00 && code <= 0xd7af) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xff00 && code <= 0xffef)
		) {
			target.cjkChars++;
		} else {
			target.otherChars++;
		}
	}
}

function estimateTokens(estimate: TokenEstimate): number {
	return estimate.cjkChars + estimate.otherChars / 4;
}

function latestAssistantMessage(manager: ReadonlySessionManager): AssistantMessage | undefined {
	let entry = manager.getLeafEntry();
	while (entry) {
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
	}
	return undefined;
}

/**
 * Decode speed of a finished response: all output tokens over the request duration, less the part of
 * the first-token wait the stream can vouch for.
 *
 * The time before the first delta was pure waiting for the tokens that then streamed, but it is when
 * the tokens that never streamed (hidden reasoning) were generated. So the wait is deducted in
 * proportion to the share of output that streamed: all of it for a fully visible response, none of it
 * when the stream is too short to be more than a transport burst. The result always lies between
 * whole-request throughput and output over the stream window.
 */
function settledTps(message: AssistantMessage, stream: StreamObservation): number | undefined {
	const output = message.usage.output;
	const durationMs = message.durationMs;
	if (output > 0 && durationMs !== undefined) {
		const windowMs = Math.min(stream.windowMs, durationMs);
		const streamedShare = windowMs >= TPS_MIN_WINDOW_MS ? Math.min(1, stream.tokens / output) : 0;
		return rate(output, durationMs - (durationMs - windowMs) * streamedShare);
	}
	// No provider count or request duration to reconcile with: the stream is the only evidence.
	return rate(stream.tokens - stream.openingTokens, stream.windowMs);
}

/**
 * Tracks tokens per second for the latest main-session assistant response. Only stream observations
 * are stored; the displayed value is derived on every read from the message it describes.
 */
export class TpsTracker {
	private readonly now: () => number;
	private active?: ActiveStream;
	/** Finalized by `message_end`, which runs before the session persists the message. */
	private ended?: AssistantMessage;
	private observations = new Map<string, StreamObservation>();

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	onSessionStart(sessionId: string, reason?: "startup" | "reload" | "new" | "resume" | "fork"): void {
		this.active = undefined;
		this.ended = undefined;
		this.observations = (reason === "reload" ? reloadSnapshots.get(sessionId) : undefined) ?? new Map();
		reloadSnapshots.delete(sessionId);
	}

	onSessionShutdown(sessionId: string, reason?: "quit" | "reload" | "new" | "resume" | "fork"): void {
		this.active = undefined;
		this.ended = undefined;
		reloadSnapshots.delete(sessionId);
		if (reason === "reload") {
			if (reloadSnapshots.size >= MAX_RELOAD_SNAPSHOTS) {
				const oldestKey = reloadSnapshots.keys().next().value;
				if (oldestKey !== undefined) reloadSnapshots.delete(oldestKey);
			}
			reloadSnapshots.set(sessionId, this.observations);
		}
		this.observations = new Map();
	}

	onSessionTree(): void {
		this.active = undefined;
		this.ended = undefined;
	}

	onMessageStart(role: string): void {
		if (role !== "assistant") return;
		this.ended = undefined;
		this.active = { cjkChars: 0, otherChars: 0, openingTokens: 0 };
	}

	/** Returns whether the footer should repaint for a new live value. */
	onMessageUpdate(role: string, assistantEvent: AssistantMessageEvent): boolean {
		if (role !== "assistant") return false;
		if (
			assistantEvent.type !== "text_delta" &&
			assistantEvent.type !== "thinking_delta" &&
			assistantEvent.type !== "toolcall_delta"
		) {
			return false;
		}
		if (!assistantEvent.delta) return false;

		this.active ??= { cjkChars: 0, otherChars: 0, openingTokens: 0 };
		const active = this.active;
		const timestamp = this.now();
		addCharCounts(active, assistantEvent.delta);
		if (active.firstDeltaAt === undefined) {
			active.firstDeltaAt = timestamp;
			active.openingTokens = estimateTokens(active);
			return false;
		}

		if (this.liveTps() === undefined) return false;
		if (
			active.lastRenderRequestAt !== undefined &&
			timestamp - active.lastRenderRequestAt < TPS_LIVE_UPDATE_INTERVAL_MS
		) {
			return false;
		}
		active.lastRenderRequestAt = timestamp;
		return true;
	}

	/** Returns whether the footer should repaint: it now describes this message, measurable or not. */
	onMessageEnd(message: { role: string }): boolean {
		if (message.role !== "assistant") return false;
		const active = this.active;
		this.active = undefined;
		const assistant = message as AssistantMessage;
		this.ended = assistant;

		const key = messageSignature(assistant);
		if (this.observations.size >= MAX_OBSERVED_MESSAGES && !this.observations.has(key)) {
			const oldestKey = this.observations.keys().next().value;
			if (oldestKey !== undefined) this.observations.delete(oldestKey);
		}
		this.observations.set(key, {
			windowMs: active?.firstDeltaAt === undefined ? 0 : Math.max(0, this.now() - active.firstDeltaAt),
			tokens: active ? estimateTokens(active) : 0,
			openingTokens: active?.openingTokens ?? 0,
		});
		return true;
	}

	onAgentEnd(): void {
		this.active = undefined;
	}

	read(sessionManager: ReadonlySessionManager, model?: Pick<Model<string>, "provider" | "id">): number | undefined {
		const live = this.liveTps();
		if (live !== undefined) return live;

		const latest = latestAssistantMessage(sessionManager);
		if (this.ended && latest && messageSignature(latest) === messageSignature(this.ended)) {
			this.ended = undefined;
		}
		const message = this.ended ?? latest;
		if (!message) return undefined;
		if (model && (message.provider !== model.provider || message.model !== model.id)) return undefined;
		const stream = this.observations.get(messageSignature(message));
		return stream ? settledTps(message, stream) : undefined;
	}

	/** Streamed rate so far, measured to now so it decays while the stream is silent. */
	private liveTps(): number | undefined {
		const active = this.active;
		if (active?.firstDeltaAt === undefined) return undefined;
		return rate(estimateTokens(active) - active.openingTokens, this.now() - active.firstDeltaAt);
	}
}
