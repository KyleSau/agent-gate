import type { Resident } from "../domain/types.js";

export type PiiScope = "none" | "limited" | "full";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redacts resident PII from a tool result before the model sees it.
 *
 * It runs on the serialized result string (the exact bytes that go to the model), so there is
 * no nested field or free-text description that can slip past it. Two layers:
 *   1. pattern-based: any email address or phone number, wherever it appears
 *   2. dictionary-based: known resident names from the system of record
 *
 * Scopes: none    -> names become [RESIDENT R-xxx], no contact details
 *         limited -> first name kept (enough for a greeting), everything else redacted
 *         full    -> unchanged (no agent in this repo has it)
 */
export class Redactor {
  constructor(private readonly residents: Resident[]) {}

  redact(text: string, scope: PiiScope): { text: string; count: number } {
    if (scope === "full") return { text, count: 0 };
    let count = 0;
    const sub = (pattern: RegExp, replacement: string) => {
      text = text.replace(pattern, () => {
        count++;
        return replacement;
      });
    };
    sub(EMAIL, "[EMAIL]");
    sub(PHONE, "[PHONE]");
    for (const r of this.residents) {
      const first = escapeRegex(r.firstName);
      const last = escapeRegex(r.lastName);
      sub(new RegExp(`\\b${first}\\s+${last}\\b`, "gi"), scope === "limited" ? r.firstName : `[RESIDENT ${r.id}]`);
      sub(new RegExp(`\\b${last}\\b`, "gi"), "[REDACTED]");
      if (scope === "none") sub(new RegExp(`\\b${first}\\b`, "gi"), "[REDACTED]");
    }
    return { text, count };
  }
}
