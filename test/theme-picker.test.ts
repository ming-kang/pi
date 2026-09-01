import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThemesDir } from "../src/config.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getResolvedThemeColors,
	getThemeByName,
	setRegisteredThemes,
} from "../src/modes/interactive/theme/theme.ts";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
};

describe("theme picker", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-picker-"));
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "themes"), { recursive: true });
		setRegisteredThemes([]);
	});

	afterEach(() => {
		setRegisteredThemes([]);
		rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("includes the bundled ice-cream themes", () => {
		for (const name of ["ice-cream-dark", "ice-cream-light"]) {
			expect(getAvailableThemes()).toContain(name);
			expect(getAvailableThemesWithPaths()).toContainEqual({
				name,
				path: join(getThemesDir(), `${name}.json`),
			});
			expect(getThemeByName(name)?.name).toBe(name);
		}
	});

	it("exports empty ice-cream backgrounds as transparent", () => {
		for (const name of ["ice-cream-dark", "ice-cream-light"]) {
			const colors = getResolvedThemeColors(name);
			expect(colors.customMessageBg).toBe("transparent");
			expect(colors.toolPendingBg).toBe("transparent");
			expect(colors.toolSuccessBg).toBe("transparent");
			expect(colors.toolErrorBg).toBe("transparent");
			expect(colors.text).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("uses the resolved text color for empty foreground values", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "empty-foreground",
			colors: { ...darkTheme.colors, text: "#123456", customMessageText: "" },
		};
		writeFileSync(
			join(process.env.PI_CODING_AGENT_DIR!, "themes", "empty-foreground.json"),
			JSON.stringify(customTheme, null, 2),
		);

		expect(getResolvedThemeColors("empty-foreground").customMessageText).toBe("#123456");
	});

	it("uses custom theme content names instead of file names", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const customTheme: ThemeFile = {
			...darkTheme,
			name: "bar",
		};

		const themePath = join(process.env.PI_CODING_AGENT_DIR!, "themes", "foo.json");
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		expect(getAvailableThemes()).toContain("bar");
		expect(getAvailableThemes()).not.toContain("foo");
		expect(getAvailableThemesWithPaths()).toContainEqual({ name: "bar", path: themePath });
		expect(getAvailableThemesWithPaths().some((theme) => theme.name === "foo")).toBe(false);
	});
});
