// Text from the API (event messages, app names, error messages) and from app folders (file names)
// can hold terminal control sequences that clear lines, change the window title, or hide links.
// Human output shows those characters as visible escapes instead; --json output is left unchanged.

// C0 controls other than tab, DEL, C1 controls, and the bidirectional overrides that can reorder text.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu;

/** Shows control characters in one line of text as visible escapes such as \x1b or \n. */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    const code = character.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Applies terminalSafe to every string (and object key) in a parsed JSON value. */
export function terminalSafeValue<T>(value: T): T {
  if (typeof value === "string") {
    return terminalSafe(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => terminalSafeValue(entry)) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [terminalSafe(key), terminalSafeValue(entry)])) as T;
  }
  return value;
}

/** Applies terminalSafe to each line of multi-line output, keeping the line breaks. */
export function terminalSafeLines(text: string): string {
  return text.split("\n").map(terminalSafe).join("\n");
}
