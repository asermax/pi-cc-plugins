import { describe, expect, it } from "vitest";
import { normalizeSkillName, sanitizeSkillMarkdown } from "../src/skills.js";

describe("normalizeSkillName", () => {
	it("converts Claude skill names to Pi-compatible names", () => {
		expect(normalizeSkillName("posthog_user_sessions")).toBe("posthog-user-sessions");
		expect(normalizeSkillName(" Notion/Knowledge Capture ")).toBe("notion-knowledge-capture");
	});
});

describe("sanitizeSkillMarkdown", () => {
	it("quotes scalar frontmatter values that strict YAML would reject", () => {
		const result = sanitizeSkillMarkdown(`---
name: code-search
description: Use when: debugging, and do NOT use for: simple file reads
argument-hint: [repo-name] [branch-name]
---

# Code Search
`, "code-search");

		expect(result).toContain('name: "code-search"');
		expect(result).toContain('description: "Use when: debugging, and do NOT use for: simple file reads"');
		expect(result).toContain('argument-hint: "[repo-name] [branch-name]"');
		expect(result).toContain("# Code Search");
	});

	it("normalizes invalid skill names", () => {
		const result = sanitizeSkillMarkdown(`---
name: posthog_user_sessions
description: Get sessions
---
Body
`, "posthog");

		expect(result).toContain('name: "posthog-user-sessions"');
	});

	it("preserves booleans and block scalar frontmatter", () => {
		const result = sanitizeSkillMarkdown(`---
name: data-search
user-invocable: false
description: |
  Use when: production data helps.
  Do NOT use for: code exploration.
---
Body
`, "data-search");

		expect(result).toContain("user-invocable: false");
		expect(result).toContain("description: |\n  Use when: production data helps.");
	});
});
