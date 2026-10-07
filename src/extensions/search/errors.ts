/** The failure taxonomy both Devin clients classify their transport errors into. */

export type SearchErrorCode =
	| "TIMEOUT"
	| "PAYLOAD_TOO_LARGE"
	| "RATE_LIMITED"
	| "AUTH_ERROR"
	| "SERVER_ERROR"
	| "NETWORK_ERROR";

export class SearchError extends Error {
	code: SearchErrorCode;
	details: Record<string, unknown>;
	constructor(message: string, code: SearchErrorCode, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "SearchError";
		this.code = code;
		this.details = details;
	}
}

/** An error that carries an HTTP status, which is what `classifyError` keys off. */
export interface HttpishError extends Error {
	status?: number;
}

export function classifyError(err: HttpishError): SearchError {
	if (err instanceof SearchError) return err;
	if (err.status) {
		const s = err.status;
		if (s === 413) return new SearchError(err.message, "PAYLOAD_TOO_LARGE", { status: s });
		if (s === 429) return new SearchError(err.message, "RATE_LIMITED", { status: s });
		if (s === 401 || s === 403) return new SearchError(err.message, "AUTH_ERROR", { status: s });
		return new SearchError(err.message, "SERVER_ERROR", { status: s });
	}
	if (err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message)) {
		return new SearchError(err.message, "TIMEOUT");
	}
	return new SearchError(err.message, "NETWORK_ERROR");
}
