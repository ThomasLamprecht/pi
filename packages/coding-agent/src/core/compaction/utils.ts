/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message, or from the nested calls
 * recorded on a tool result.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		// Calls made from codemode scripts are recorded on the script's result.
		for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		return;
	}
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;
		addFileOp(block.name, block.arguments as Record<string, unknown> | undefined, fileOps);
	}
}

function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: FileOperations): void {
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (!path) return;
	switch (toolName) {
		case "read":
			fileOps.read.add(path);
			break;
		case "write":
			fileOps.written.add(path);
			break;
		case "edit":
			fileOps.edited.add(path);
			break;
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Keep cumulative file tracking from dominating the summary's model context. */
const FILE_LIST_MAX_CHARS = 4000;

function formatFileList(tag: string, files: string[], maxChars: number): string {
	if (files.length === 0) return "";
	const prefix = `<${tag}>\n`;
	const suffix = `\n</${tag}>`;
	const content = files.join("\n");
	if (prefix.length + content.length + suffix.length <= maxChars) return prefix + content + suffix;

	// Reserve room for the omission notice and keep paths intact. Each list has its own budget so a large read-only
	// history cannot crowd out modified files.
	const notice = (count: number) => `[... ${count} more ${count === 1 ? "file" : "files"} in session details]`;
	let remaining = maxChars - prefix.length - suffix.length - notice(files.length).length;
	const kept: string[] = [];
	for (const path of files) {
		if (path.length + 1 > remaining) break;
		kept.push(path);
		remaining -= path.length + 1;
	}
	return prefix + [...kept, notice(files.length - kept.length)].join("\n") + suffix;
}

/** Format a bounded preview; the complete lists remain in session entry details. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections = [
		formatFileList("read-files", readFiles, FILE_LIST_MAX_CHARS),
		formatFileList("modified-files", modifiedFiles, FILE_LIST_MAX_CHARS),
	].filter(Boolean);
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/**
 * Remove only a generated trailer that matches the entry's file metadata. Re-summarizing the trailer can copy cumulative
 * file lists into prose, outside the bounded preview appended by Pi.
 */
export function stripFileOperations(summary: string, details: unknown): string {
	if (!details || typeof details !== "object") return summary;
	const { readFiles = [], modifiedFiles = [] } = details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (
		!Array.isArray(readFiles) ||
		!Array.isArray(modifiedFiles) ||
		!readFiles.every((path) => typeof path === "string") ||
		!modifiedFiles.every((path) => typeof path === "string")
	) {
		return summary;
	}

	const preview = formatFileOperations(readFiles, modifiedFiles);
	if (preview && summary.endsWith(preview)) return summary.slice(0, -preview.length);

	// Existing sessions can contain the complete lists rather than a bounded preview.
	const sections = [
		formatFileList("read-files", readFiles, Infinity),
		formatFileList("modified-files", modifiedFiles, Infinity),
	].filter(Boolean);
	const full = sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
	return full && summary.endsWith(full) ? summary.slice(0, -full.length) : summary;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 *
 * Thinking is omitted. Providers return summaries of the real reasoning, and
 * replayed thinking is often not part of the model's live context: for example,
 * a block that does not match its request is dropped. Including it can make the
 * summarization request larger than the context it summarizes. Visible text,
 * tool calls, and tool results record what happened.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
