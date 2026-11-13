import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { ReadonlySessionManager, SessionEntry } from "../../core/session-manager.ts";

export const TPS_MIN_LIVE_MS = 250;
export const TPS_MIN_LIVE_TOKENS = 2;
export const TPS_LIVE_UPDATE_INTERVAL_MS = 200;
export const TPS_MIN_DECODE_MS = 20;
const MAX_CACHED_MESSAGES = 64;
const MAX_RELOAD_SNAPSHOTS = 16;

interface ActiveMeasurement {
	firstTokenAt?: number;
	cjkChars: number;
	otherChars: number;
	lastSampleAt: number;
	liveTps?: number;
}

interface PendingReconciliation {
	decodeMs: number;
	estimatedTokens: number;
	messageTimestamp: number;
	stopReason: AssistantMessage["stopReason"];
	settledOutput?: number;
}

interface SettledTps {
	tps: number;
	messageKey?: string;
}

interface ReloadSnapshot {
	settled?: SettledTps;
	byMessage: Map<string, number>;
	clearedByModelSelect: boolean;
}

const reloadSnapshots = new Map<string, ReloadSnapshot>();

function messageSignature(message: Pick<AssistantMessage, "timestamp" | "provider" | "model">): string {
	return `${message.timestamp}:${message.provider}:${message.model}`;
}

function addCharCounts(target: ActiveMeasurement, text: string): void {
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

function latestAssistantMessage(entries: readonly SessionEntry[]): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

/**
 * Tracks decode-only tokens per second (TTFT and tool time excluded) for the latest
 * main-session assistant response, reconciling live estimates with final provider usage.
 */
export class TpsTracker {
	private readonly now: () => number;
	private active?: ActiveMeasurement;
	private pending?: PendingReconciliation;
	private settled?: SettledTps;
	private byMessage = new Map<string, number>();
	private clearedByModelSelect = false;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	onSessionStart(sessionId: string, reason?: "startup" | "reload" | "new" | "resume" | "fork"): void {
		this.active = undefined;
		this.pending = undefined;
		if (reason === "reload") {
			const snapshot = reloadSnapshots.get(sessionId);
			reloadSnapshots.delete(sessionId);
			if (snapshot) {
				this.settled = snapshot.settled;
				this.byMessage = new Map(snapshot.byMessage);
				this.clearedByModelSelect = snapshot.clearedByModelSelect;
				return;
			}
		} else {
			reloadSnapshots.delete(sessionId);
		}
		this.settled = undefined;
		this.byMessage.clear();
		this.clearedByModelSelect = false;
	}

	onSessionShutdown(sessionId: string, reason?: "quit" | "reload" | "new" | "resume" | "fork"): void {
		this.active = undefined;
		this.pending = undefined;
		if (reason === "reload") {
			if (reloadSnapshots.size >= MAX_RELOAD_SNAPSHOTS) {
				const oldestKey = reloadSnapshots.keys().next().value;
				if (oldestKey !== undefined) reloadSnapshots.delete(oldestKey);
			}
			reloadSnapshots.set(sessionId, {
				settled: this.settled,
				byMessage: new Map(this.byMessage),
				clearedByModelSelect: this.clearedByModelSelect,
			});
			return;
		}
		reloadSnapshots.delete(sessionId);
		this.settled = undefined;
		this.byMessage.clear();
		this.clearedByModelSelect = false;
	}

	onModelSelect(
		model: Pick<Model<string>, "provider" | "id">,
		previousModel?: Pick<Model<string>, "provider" | "id">,
	): void {
		if (previousModel && previousModel.provider === model.provider && previousModel.id === model.id) return;
		this.active = undefined;
		this.pending = undefined;
		this.settled = undefined;
		this.clearedByModelSelect = true;
	}

	onSessionTree(sessionManager: ReadonlySessionManager): void {
		this.active = undefined;
		this.pending = undefined;
		if (this.clearedByModelSelect) {
			this.settled = undefined;
			return;
		}
		const latest = latestAssistantMessage(sessionManager.getBranch());
		if (!latest) {
			this.settled = undefined;
			return;
		}
		const key = messageSignature(latest);
		const cached = this.byMessage.get(key);
		this.settled = cached !== undefined ? { tps: cached, messageKey: key } : undefined;
	}

	onMessageStart(role: string): void {
		if (role !== "assistant") return;
		this.pending = undefined;
		this.active = { cjkChars: 0, otherChars: 0, lastSampleAt: 0 };
	}

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

		this.active ??= { cjkChars: 0, otherChars: 0, lastSampleAt: 0 };
		const timestamp = this.now();
		this.active.firstTokenAt ??= timestamp;
		addCharCounts(this.active, assistantEvent.delta);

		const decodeMs = timestamp - this.active.firstTokenAt;
		const estimatedTokens = this.active.cjkChars + this.active.otherChars / 4;
		if (decodeMs < TPS_MIN_LIVE_MS || estimatedTokens < TPS_MIN_LIVE_TOKENS) {
			return false;
		}
		if (this.active.liveTps !== undefined && timestamp - this.active.lastSampleAt < TPS_LIVE_UPDATE_INTERVAL_MS) {
			return false;
		}
		this.active.liveTps = estimatedTokens / (decodeMs / 1000);
		this.active.lastSampleAt = timestamp;
		return true;
	}

	onMessageEnd(message: { role: string }): boolean {
		if (message.role !== "assistant") return false;
		const active = this.active;
		this.active = undefined;
		if (!active || active.firstTokenAt === undefined) return false;

		const decodeMs = Math.max(0, this.now() - active.firstTokenAt);
		if (decodeMs < TPS_MIN_DECODE_MS) return false;

		const assistant = message as AssistantMessage;
		const estimatedTokens = active.cjkChars + active.otherChars / 4;
		if (assistant.usage.output > 0) {
			this.recordSettled(assistant.usage.output / (decodeMs / 1000), assistant);
			this.pending = {
				decodeMs,
				estimatedTokens,
				messageTimestamp: assistant.timestamp,
				stopReason: assistant.stopReason,
				settledOutput: assistant.usage.output,
			};
			return true;
		}

		this.pending = {
			decodeMs,
			estimatedTokens,
			messageTimestamp: assistant.timestamp,
			stopReason: assistant.stopReason,
		};
		return false;
	}

	onAgentEnd(): void {
		this.active = undefined;
	}

	read(sessionManager: ReadonlySessionManager): number | undefined {
		if (this.active?.liveTps !== undefined) return this.active.liveTps;

		if (this.pending) {
			const latest = latestAssistantMessage(sessionManager.getBranch());
			if (latest && latest.timestamp === this.pending.messageTimestamp) {
				const pending = this.pending;
				this.pending = undefined;
				if (latest.usage.output > 0) {
					if (latest.usage.output !== pending.settledOutput) {
						this.recordSettled(latest.usage.output / (pending.decodeMs / 1000), latest);
					}
				} else if (
					pending.settledOutput === undefined &&
					pending.stopReason !== "error" &&
					pending.estimatedTokens >= TPS_MIN_LIVE_TOKENS
				) {
					this.recordSettled(pending.estimatedTokens / (pending.decodeMs / 1000), latest);
				}
			}
		}

		return this.settled?.tps;
	}

	private recordSettled(tps: number, message: AssistantMessage): void {
		if (!Number.isFinite(tps) || tps < 0) return;
		const key = messageSignature(message);
		if (this.byMessage.size >= MAX_CACHED_MESSAGES && !this.byMessage.has(key)) {
			const oldestKey = this.byMessage.keys().next().value;
			if (oldestKey !== undefined) this.byMessage.delete(oldestKey);
		}
		this.byMessage.set(key, tps);
		this.settled = { tps, messageKey: key };
		this.clearedByModelSelect = false;
	}
}
