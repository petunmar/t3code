// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const FILE_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/xml": ".xml",
};
const SAFE_FILE_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".csv",
  ".docx",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".pdf",
  ".pptx",
  ".py",
  ".rs",
  ".rtf",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
]);
const ATTACHMENT_FILENAME_EXTENSIONS = [
  ...SAFE_IMAGE_FILE_EXTENSIONS,
  ...SAFE_FILE_EXTENSIONS,
  ".bin",
];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export interface ResolvedFileAttachment {
  readonly attachment: Extract<ChatAttachment, { readonly type: "file" }>;
  readonly path: string;
}

export function appendResolvedFileAttachmentsToPrompt(
  prompt: string | undefined,
  files: ReadonlyArray<ResolvedFileAttachment>,
): string | undefined {
  const trimmedPrompt = prompt?.trim();
  if (files.length === 0) {
    return trimmedPrompt || undefined;
  }
  const section = [
    "<attached_files>",
    "The user attached these files. Read them from the local paths below before answering.",
    ...files.map(
      ({ attachment, path }) =>
        `- name=${JSON.stringify(attachment.name)} mime=${JSON.stringify(attachment.mimeType)} path=${JSON.stringify(path)}`,
    ),
    "</attached_files>",
  ].join("\n");
  return trimmedPrompt ? `${trimmedPrompt}\n\n${section}` : section;
}

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file": {
      const mimeExtension = FILE_EXTENSION_BY_MIME_TYPE[attachment.mimeType.toLowerCase()];
      const nameExtension = NodePath.extname(attachment.name).toLowerCase();
      const extension =
        mimeExtension ?? (SAFE_FILE_EXTENSIONS.has(nameExtension) ? nameExtension : ".bin");
      return `${attachment.id}${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
