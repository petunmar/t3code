// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  appendResolvedFileAttachmentsToPrompt,
  attachmentRelativePath,
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("keeps a PDF extension and resolves it by attachment id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    const attachment = {
      type: "file" as const,
      id: "thread-file-00000000-0000-4000-8000-000000000001",
      name: "requirements.pdf",
      mimeType: "application/pdf",
      sizeBytes: 5,
    };
    try {
      expect(attachmentRelativePath(attachment)).toBe(`${attachment.id}.pdf`);
      const pdfPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
      NodeFS.writeFileSync(pdfPath, Buffer.from("hello"));
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: attachment.id })).toBe(
        pdfPath,
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("adds resolved file paths to provider prompts", () => {
    const prompt = appendResolvedFileAttachmentsToPrompt("Summarize this", [
      {
        attachment: {
          type: "file",
          id: "thread-file-00000000-0000-4000-8000-000000000001",
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5,
        },
        path: "/tmp/t3/attachment.pdf",
      },
    ]);

    expect(prompt).toContain("Summarize this");
    expect(prompt).toContain("<attached_files>");
    expect(prompt).toContain('name="requirements.pdf"');
    expect(prompt).toContain('path="/tmp/t3/attachment.pdf"');
  });
});
