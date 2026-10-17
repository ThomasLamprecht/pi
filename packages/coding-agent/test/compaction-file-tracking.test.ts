import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	formatFileOperations,
	generateBranchSummary,
	prepareBranchEntries,
	prepareCompaction,
	stripFileOperations,
} from "../src/core/compaction/index.ts";
import { type BranchSummaryEntry, type CompactionEntry, SessionManager } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
const prose = "## Goal\nContinue work on src/current.ts.";

function fileLists(count = 2500) {
	return {
		readFiles: Array.from({ length: count }, (_, i) => `/workspace/${"historical/".repeat(10)}read-${i}.ts`).sort(),
		modifiedFiles: Array.from(
			{ length: count },
			(_, i) => `/workspace/${"historical/".repeat(10)}edit-${i}.ts`,
		).sort(),
	};
}

function fullTrailer({ readFiles, modifiedFiles }: ReturnType<typeof fileLists>): string {
	return `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
}

function summaryStream(prompts: string[] = []): StreamFn {
	return (_model, context) => {
		prompts.push(JSON.stringify(context.messages));
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage(prose) }));
		return stream;
	};
}

function branchEntry(details = fileLists(), fromHook = false): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id: "branch-summary",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		fromId: "old-branch",
		summary: prose + fullTrailer(details),
		details,
		fromHook,
	};
}

describe("file operation previews", () => {
	it("preserves the complete format for small lists", () => {
		expect(formatFileOperations([], [])).toBe("");
		expect(formatFileOperations(["read.ts"], [])).toBe("\n\n<read-files>\nread.ts\n</read-files>");
		expect(formatFileOperations([], ["edit.ts"])).toBe("\n\n<modified-files>\nedit.ts\n</modified-files>");
		expect(formatFileOperations(["read.ts"], ["edit.ts"])).toBe(
			fullTrailer({ readFiles: ["read.ts"], modifiedFiles: ["edit.ts"] }),
		);
	});

	it("bounds both lists independently without truncating individual paths", () => {
		const details = fileLists();
		const preview = formatFileOperations(details.readFiles, details.modifiedFiles);
		expect(preview.length).toBeLessThanOrEqual(8004);
		for (const [tag, files] of [
			["read-files", details.readFiles],
			["modified-files", details.modifiedFiles],
		] as const) {
			const section = preview.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
			expect(section).not.toBeNull();
			expect(section![0].length).toBeLessThanOrEqual(4000);
			const lines = section![1].split("\n");
			const notice = lines.pop();
			expect(lines.length).toBeGreaterThan(0);
			expect(lines).toEqual(files.slice(0, lines.length));
			expect(notice).toBe(`[... ${files.length - lines.length} more files in session details]`);
		}
	});

	it("omits a path larger than the budget rather than returning a partial path", () => {
		const preview = formatFileOperations(["x".repeat(10000)], ["src/current.ts"]);
		expect(preview).toContain("<read-files>\n[... 1 more file in session details]\n</read-files>");
		expect(preview).toContain("<modified-files>\nsrc/current.ts\n</modified-files>");
		expect(preview).not.toContain("xxx");
	});

	it("includes a list that fits exactly and bounds one just over the limit", () => {
		const overhead = "<read-files>\n\n</read-files>".length;
		const path = "x".repeat(4000 - overhead);
		expect(formatFileOperations([path], [])).toBe(`\n\n<read-files>\n${path}\n</read-files>`);
		expect(formatFileOperations([`${path}x`], []).length).toBeLessThanOrEqual(4002);
		expect(formatFileOperations([`${path}x`], [])).toContain("1 more file in session details");
	});

	it("strips matching full and bounded trailers without mutating metadata", () => {
		const details = fileLists();
		const original = structuredClone(details);
		expect(stripFileOperations(prose + fullTrailer(details), details)).toBe(prose);
		expect(stripFileOperations(prose + formatFileOperations(details.readFiles, details.modifiedFiles), details)).toBe(
			prose,
		);
		expect(details).toEqual(original);
	});

	it("leaves unrelated summary text and unknown metadata untouched", () => {
		const details = fileLists(1);
		const summary = prose + fullTrailer(details);
		for (const metadata of [undefined, null, {}, { readFiles: "invalid" }, { modifiedFiles: [123] }, fileLists(2)]) {
			expect(stripFileOperations(summary, metadata)).toBe(summary);
		}
		expect(stripFileOperations(`${summary}\nKeep this text.`, details)).toBe(`${summary}\nKeep this text.`);
		expect(stripFileOperations(summary + summary, details)).toBe(summary + prose);
	});
});

describe("cumulative file tracking", () => {
	it.each([false, true])(
		"bounds repeated compactions while preserving metadata (split turn: %s)",
		async (splitTurn) => {
			const details = fileLists();
			const manager = SessionManager.inMemory();
			const kept = manager.appendMessage({ role: "user", content: "Continue the task", timestamp: 1 });
			manager.appendCompaction(prose + fullTrailer(details), kept, 200000, details);
			const prompts: string[] = [];
			const streamFn = summaryStream(prompts);

			for (let i = 0; i < 3; i++) {
				const path = `src/current-${i}.ts`;
				manager.appendMessage({
					...fauxAssistantMessage(""),
					content: [{ type: "toolCall", id: `write-${i}`, name: "write", arguments: { path, content: "code" } }],
				});
				manager.appendMessage({
					role: "toolResult",
					toolCallId: `write-${i}`,
					toolName: "write",
					content: [{ type: "text", text: "Written" }],
					isError: false,
					timestamp: 2,
				});
				manager.appendMessage(
					splitTurn
						? fauxAssistantMessage("Continuing the same turn")
						: { role: "user", content: "Continue the next task", timestamp: 3 },
				);
				const preparation = prepareCompaction(manager.getBranch(), settings)!;
				expect(preparation).toBeDefined();
				expect(preparation.isSplitTurn).toBe(splitTurn && i === 0);
				expect(preparation.previousSummary).toContain(prose);
				expect(preparation.previousSummary).not.toContain("<read-files>");
				expect(preparation.previousSummary).not.toContain("<modified-files>");

				const result = await compact(
					preparation,
					model,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					streamFn,
				);
				const stored = result.details as typeof details;
				expect(stored.readFiles).toHaveLength(2500);
				expect(stored.modifiedFiles).toHaveLength(2501 + i);
				expect(stored.modifiedFiles).toContain(path);
				expect(stored.modifiedFiles).toContain(details.modifiedFiles[2499]);
				expect(result.summary.length).toBeLessThan(9000);
				expect(result.summary.match(/<read-files>/g)).toHaveLength(1);
				expect(result.summary.match(/<modified-files>/g)).toHaveLength(1);
				manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details);
				const context = manager.buildSessionContext();
				expect(JSON.stringify(context.messages).length).toBeLessThan(10000);
			}
			expect(prompts.every((prompt) => !prompt.includes("historical/"))).toBe(true);
			expect(prompts).toHaveLength(3);
		},
	);

	it("leaves extension compaction summaries and their metadata under extension control", () => {
		const details = fileLists();
		const summary = prose + fullTrailer(details);
		const manager = SessionManager.inMemory();
		const kept = manager.appendMessage({ role: "user", content: "Continue", timestamp: 1 });
		manager.appendCompaction(summary, kept, 200000, details, true);
		manager.appendMessage({ role: "user", content: "Next task", timestamp: 2 });
		const preparation = prepareCompaction(manager.getBranch(), settings)!;
		expect(preparation.previousSummary).toBe(summary);
		expect(preparation.fileOps.read.size).toBe(0);
		expect(preparation.fileOps.edited.size).toBe(0);
	});

	it.each([false, true])(
		"handles branch summaries in compaction without rewriting source entries (extension: %s)",
		(fromHook) => {
			const entry = branchEntry(fileLists(), fromHook);
			const original = structuredClone(entry);
			const preparation = prepareCompaction(
				[
					entry,
					{
						type: "message",
						id: "next-user",
						parentId: entry.id,
						timestamp: new Date(2).toISOString(),
						message: { role: "user", content: "Next task", timestamp: 2 },
					},
				],
				settings,
			)!;
			expect(preparation.messagesToSummarize).toMatchObject([
				{ role: "branchSummary", summary: fromHook ? entry.summary : prose },
			]);
			expect(preparation.fileOps.read.size).toBe(fromHook ? 0 : 2500);
			expect(preparation.fileOps.edited.size).toBe(fromHook ? 0 : 2500);
			expect(entry).toEqual(original);
		},
	);

	it.each([false, true])(
		"prepares branch and compaction summaries before estimating branch tokens (extension: %s)",
		(fromHook) => {
			const branch = branchEntry(fileLists(), fromHook);
			const compactionDetails = { readFiles: ["compaction-read.ts"], modifiedFiles: ["compaction-edit.ts"] };
			const compaction: CompactionEntry = {
				type: "compaction",
				id: "compaction",
				parentId: branch.id,
				timestamp: new Date(2).toISOString(),
				firstKeptEntryId: branch.id,
				tokensBefore: 200000,
				summary: prose + fullTrailer(compactionDetails),
				details: compactionDetails,
				fromHook,
			};
			const preparation = prepareBranchEntries([branch, compaction]);
			expect(preparation.messages).toMatchObject([
				{ role: "branchSummary", summary: fromHook ? branch.summary : prose },
				{ role: "compactionSummary", summary: fromHook ? compaction.summary : prose },
			]);
			expect(preparation.fileOps.read.size).toBe(fromHook ? 0 : 2501);
			expect(preparation.fileOps.read.has("compaction-read.ts")).toBe(!fromHook);
			expect(preparation.fileOps.edited.has("compaction-edit.ts")).toBe(!fromHook);
			if (!fromHook) {
				expect(preparation.totalTokens).toBe(2 * Math.ceil(prose.length / 4));
				expect(prepareBranchEntries([branch, compaction], 100).messages).toHaveLength(2);
			}
		},
	);

	it("bounds nested branch summaries while retaining cumulative file metadata", async () => {
		let entry = branchEntry();
		const details = entry.details;
		const prompts: string[] = [];
		for (let i = 0; i < 3; i++) {
			const result = await generateBranchSummary([entry], {
				model,
				signal: new AbortController().signal,
				streamFn: summaryStream(prompts),
			});
			expect(result.summary!.length).toBeLessThan(9000);
			expect({ readFiles: result.readFiles, modifiedFiles: result.modifiedFiles }).toEqual(details);
			entry = {
				...entry,
				summary: result.summary!,
				details: { readFiles: result.readFiles!, modifiedFiles: result.modifiedFiles! },
			};
		}
		expect(prompts.every((prompt) => !prompt.includes("historical/"))).toBe(true);
	});
});
