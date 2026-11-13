import { describe, expect, test } from "vitest";
import { editJsonText } from "../src/extensions/provider/jsonc-edit.ts";
import { stripJsonComments } from "../src/utils/json.ts";

const read = (text: string): unknown => JSON.parse(stripJsonComments(text));

/** Edit `text` so it reads back as `change(parsed)`. */
function edit(text: string, change: (doc: any) => void): string {
	const before = read(text);
	const after = structuredClone(before);
	change(after);
	const result = editJsonText(text, before, after);
	expect(read(result)).toEqual(after);
	return result;
}

describe("models.json text edits", () => {
	test("keep comments, key order and untouched formatting", () => {
		const text = `{
  // Gateways first.
  "providers": {
    "cpa": { "baseUrl": "https://cpa.example/v1", "api": "openai-completions" }, // mine
    "openai": {
      // raise the window
      "modelOverrides": {}
    }
  }
}
`;
		const result = edit(text, (doc) => {
			doc.providers.openai.modelOverrides["gpt-6-astra"] = { contextWindow: 500000 };
		});
		expect(result).toBe(`{
  // Gateways first.
  "providers": {
    "cpa": { "baseUrl": "https://cpa.example/v1", "api": "openai-completions" }, // mine
    "openai": {
      // raise the window
      "modelOverrides": {
        "gpt-6-astra": {
          "contextWindow": 500000
        }
      }
    }
  }
}
`);
	});

	test("keep block comments", () => {
		const text = `{
  /* provider catalog */
  "providers": {
    "cpa": { "baseUrl": "https://a" }
  }
}
`;
		const result = edit(text, (doc) => {
			doc.providers.cpa.api = "openai-completions";
		});
		expect(result).toContain("/* provider catalog */");
		expect(read(result)).toEqual({ providers: { cpa: { baseUrl: "https://a", api: "openai-completions" } } });
	});

	test("keep a one-line file on one line", () => {
		const text = '{"providers":{"openai":{"modelOverrides":{"gpt-6-astra":{"maxTokens":64000}}}}}\n';
		const result = edit(text, (doc) => {
			doc.providers.openai.modelOverrides["gpt-6-astra"].contextWindow = 500000;
		});
		expect(result).toBe(
			'{"providers":{"openai":{"modelOverrides":{"gpt-6-astra":{"maxTokens":64000,"contextWindow": 500000}}}}}\n',
		);
	});

	test("follow the file's indentation and line endings", () => {
		const text = '{\r\n\t"providers": {\r\n\t\t"cpa": {\r\n\t\t\t"baseUrl": "https://a"\r\n\t\t}\r\n\t}\r\n}\r\n';
		const result = edit(text, (doc) => {
			doc.providers.cpa.api = "openai-completions";
		});
		expect(result).toBe(
			'{\r\n\t"providers": {\r\n\t\t"cpa": {\r\n\t\t\t"baseUrl": "https://a",\r\n\t\t\t"api": "openai-completions"\r\n\t\t}\r\n\t}\r\n}\r\n',
		);
	});

	test("edit around trailing commas", () => {
		const text = `{
  "providers": {
    "cpa": {
      "baseUrl": "https://a", // gateway
      "models": [
        { "id": "a" },
        { "id": "b" }, // keep b
      ],
    },
  },
}
`;
		const added = edit(text, (doc) => {
			doc.providers.cpa.apiKey = "CPA_KEY";
		});
		expect(added).toContain('"apiKey": "CPA_KEY"');
		expect(added).toContain("// gateway");
		const removed = edit(text, (doc) => {
			doc.providers.cpa.models.shift();
		});
		expect(removed).toBe(`{
  "providers": {
    "cpa": {
      "baseUrl": "https://a", // gateway
      "models": [
        { "id": "b" }, // keep b
      ],
    },
  },
}
`);
	});

	test("clearing the last override removes the key, its emptied parents and their lines", () => {
		const text = `{
  "providers": {
    // Pinned window for Astra.
    "openai": {
      "modelOverrides": {
        "gpt-6-astra": { "contextWindow": 500000 },
      },
    },
    "cpa": { "baseUrl": "https://a" }, // stays
  },
}
`;
		const result = edit(text, (doc) => {
			delete doc.providers.openai;
		});
		expect(result).toBe(`{
  "providers": {
    // Pinned window for Astra.
    "cpa": { "baseUrl": "https://a" }, // stays
  },
}
`);
		const last = edit(
			`{
  "providers": {
    "openai": { "modelOverrides": { "gpt-6-astra": { "contextWindow": 500000 } } }
  }
}
`,
			(doc) => {
				delete doc.providers.openai;
			},
		);
		expect(last).toBe(`{
  "providers": {
  }
}
`);
	});

	test("append a model and keep the separator style", () => {
		const text = '{\n  "providers": {\n    "cpa": { "models": [{ "id": "a" }] }\n  }\n}\n';
		const result = edit(text, (doc) => {
			doc.providers.cpa.models.push({ id: "b" });
		});
		expect(read(result)).toEqual({ providers: { cpa: { models: [{ id: "a" }, { id: "b" }] } } });
	});

	test("a new provider goes on its own lines, leaving the one-line entry before it and its comment alone", () => {
		const withTrailingComma = `{
  "providers": {
    "cpa": { "baseUrl": "https://a", "models": [{ "id": "k3" }] }, // mine
  },
}
`;
		const add = (doc: any) => {
			doc.providers.deepseek = { modelOverrides: { "deepseek-v4-pro": { maxTokens: 64000 } } };
		};
		expect(edit(withTrailingComma, add)).toBe(`{
  "providers": {
    "cpa": { "baseUrl": "https://a", "models": [{ "id": "k3" }] }, // mine
    "deepseek": {
      "modelOverrides": {
        "deepseek-v4-pro": {
          "maxTokens": 64000
        }
      }
    },
  },
}
`);
		const withoutTrailingComma = `{
  "providers": {
    "cpa": { "baseUrl": "https://a" } // mine
  }
}
`;
		expect(edit(withoutTrailingComma, add)).toBe(`{
  "providers": {
    "cpa": { "baseUrl": "https://a" }, // mine
    "deepseek": {
      "modelOverrides": {
        "deepseek-v4-pro": {
          "maxTokens": 64000
        }
      }
    }
  }
}
`);
	});

	test("a model appended to a multi-line array keeps the entries before it as written", () => {
		const text = `{
  "providers": {
    "cpa": {
      "models": [
        { "id": "a", "name": "A" }, // first
      ],
    },
  },
}
`;
		expect(
			edit(text, (doc) => {
				doc.providers.cpa.models.push({ id: "b" });
			}),
		).toBe(`{
  "providers": {
    "cpa": {
      "models": [
        { "id": "a", "name": "A" }, // first
        {
          "id": "b"
        },
      ],
    },
  },
}
`);
	});
});
