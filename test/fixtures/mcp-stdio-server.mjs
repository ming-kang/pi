import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const request = JSON.parse(line);
	if (!("id" in request)) continue;
	const result = request.method === "initialize"
		? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
		: request.method === "tools/list"
			? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
			: request.method === "tools/call"
				? { content: [{ type: "text", text: String(request.params.arguments.text) }] }
				: {};
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
