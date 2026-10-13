/**
 * Heuristic prompt-injection detector for tool results.
 *
 * This is a tripwire, not the defense. It will miss paraphrased attacks and that is fine:
 * the actual controls are structural (tools not granted have no code path; WRITE tools need a
 * human approval). Detection adds an audit event, a warning on the tool result, and a warning
 * on any approval requested later in the same run.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ["ignore-instructions", /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier)\b.{0,20}\b(instructions|rules|prompt)/i],
  ["role-override", /\b(you are now|act as|new instructions|admin mode|developer mode)\b/i],
  ["fake-system-text", /(^|[\s>])(system|assistant)\s*:/i],
  ["markup-escape", /<\/?\s*(system|untrusted|instructions|data|tool_result)\s*>/i],
  ["approval-bypass", /\b(do not|don't|without)\b.{0,20}\b(ask|request|seek)\b.{0,20}\bapproval\b|\bpre-?approved\b/i],
  ["addressed-to-ai", /\b(note|message|instruction)s? to the (ai|assistant|model|agent)\b/i],
];

export function detectInjection(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}
