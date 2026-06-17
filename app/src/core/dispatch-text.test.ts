// src/core/dispatch-text.test.ts
// Mirrors docs/features/bdd/inter-session-messaging.feature.
import { describe, it, expect } from "vitest";
import { buildDispatchText } from "./jarvis.js";

const blocks = (r: ReturnType<typeof buildDispatchText>) =>
  Array.isArray(r) ? r : null;

describe("buildDispatchText — inter-session attribution & reply routing", () => {
  it("message from the human user (chat-input) gets no preamble", () => {
    const r = buildDispatchText({ text: "hello", source: "chat-input" });
    expect(r).toBe("hello");
  });

  it("message from jarvis-core gets no preamble even with replyTo", () => {
    const r = buildDispatchText({ text: "task", source: "jarvis-core", replyTo: "main", sourceIsLiveSession: false });
    expect(r).toBe("task");
  });

  it("message from cron gets no preamble (self-prefixed)", () => {
    const r = buildDispatchText({ text: '[CRON job "x"] tick', source: "cron" });
    expect(r).toBe('[CRON job "x"] tick');
  });

  it("plugin notification without replyTo stays plain (source is not a session)", () => {
    const r = buildDispatchText({ text: "memory saved", source: "mnemosyne", sourceIsLiveSession: false });
    expect(r).toBe("memory saved");
  });

  it("inter-session WITH replyTo carries origin + reply routing", () => {
    const r = buildDispatchText({ text: "What is 2+2?", source: "actor-alice", replyTo: "main", sourceIsLiveSession: true });
    const b = blocks(r)!;
    expect(b).toHaveLength(2);
    expect(b[0].text).toContain('sent by session "actor-alice"');
    expect(b[0].text).toContain('bus_publish');
    expect(b[0].text).toContain('target: "main"');
    expect(b[1].text).toBe("What is 2+2?");
  });

  it("non-session source WITH replyTo keeps the legacy reply preamble (compat)", () => {
    // Legacy rule preserved: any non-internal source carrying replyTo gets
    // routing instructions — plugins that request answers depend on it.
    const r = buildDispatchText({ text: "q", source: "some-plugin", replyTo: "main", sourceIsLiveSession: false });
    const b = blocks(r)!;
    expect(b).toHaveLength(2);
    expect(b[0].text).toContain('bus_publish');
  });

  it("inter-session WITHOUT replyTo carries origin attribution only (NEW)", () => {
    // The bare-"pong" fix: fire-and-forget from a live session must identify
    // the sender and must NOT instruct any reply.
    const r = buildDispatchText({ text: "pong", source: "actor-alpha", sourceIsLiveSession: true });
    const b = blocks(r)!;
    expect(b).toHaveLength(2);
    expect(b[0].text).toContain('sent by session "actor-alpha"');
    expect(b[0].text).toContain("fire-and-forget");
    expect(b[0].text).not.toContain("bus_publish");
    expect(b[1].text).toBe("pong");
  });

  it("reminders compose with the preamble in block 1", () => {
    const reminder = "<system-reminder>\nbe brief\n</system-reminder>\n\n";
    const r = buildDispatchText({ text: "hi", source: "actor-alice", replyTo: "main", reminderBlock: reminder, sourceIsLiveSession: true });
    const b = blocks(r)!;
    expect(b[1].text).toBe(reminder + "hi");
  });

  it("reminders compose for plain (user) messages too", () => {
    const reminder = "<system-reminder>\nr\n</system-reminder>\n\n";
    const r = buildDispatchText({ text: "hi", source: "chat-input", reminderBlock: reminder });
    expect(r).toBe(reminder + "hi");
  });
});
