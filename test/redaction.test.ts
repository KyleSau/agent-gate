import { describe, expect, it } from "vitest";
import type { Db } from "../src/domain/types.js";
import { Redactor } from "../src/runtime/redaction.js";
import { readJson, SEED_PATH } from "../src/util.js";

const seed = readJson<Db>(SEED_PATH);
const redactor = new Redactor(seed.residents);
const line = "Avery Sample (avery.sample@example.test, (555) 555-0101) reported a leak.";

describe("PII redaction", () => {
  it("scope none removes names, emails and phones", () => {
    expect(redactor.redact(line, "none")).toEqual({
      text: "[RESIDENT R-501] ([EMAIL], [PHONE]) reported a leak.",
      count: 3,
    });
  });

  it("scope limited keeps only the first name", () => {
    expect(redactor.redact(line, "limited").text).toBe("Avery ([EMAIL], [PHONE]) reported a leak.");
  });

  it("scope full leaves text unchanged", () => {
    expect(redactor.redact(line, "full")).toEqual({ text: line, count: 0 });
  });

  it("catches PII a resident typed into a free-text description", () => {
    const wo1004 = seed.workOrders.find((w) => w.id === "WO-1004")?.description ?? "";
    const { text } = redactor.redact(wo1004, "limited");
    expect(text).not.toMatch(/555-0144|casey\.synthetic/);
    expect(text).toContain("call my cell [PHONE] or email [EMAIL]");
  });

  it("works on serialized tool results and lone surnames", () => {
    const json = JSON.stringify({ reported_by: { name: "Jordan Placeholder" }, note: "Ms. Testwell called back" });
    const { text } = redactor.redact(json, "none");
    expect(text).toBe('{"reported_by":{"name":"[RESIDENT R-502]"},"note":"Ms. [REDACTED] called back"}');
  });

  it("does not touch non-PII content", () => {
    const text = "WO-1001 at Maple Court Apartments, unit U-101, created 2026-10-12T08:14:00Z, rent 1450";
    expect(redactor.redact(text, "none")).toEqual({ text, count: 0 });
  });
});
