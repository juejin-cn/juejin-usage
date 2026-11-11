/** Closed signatures of Harness-owned UI guidance. These are not user prompts.
 * WorkBuddy rejects the stock metadata (HTTP 400), including its literal at-sign
 * path tutorial. Keep every instruction while expressing the same UI contract
 * without those client markers. Never rewrite arbitrary mentions or user text. */
export const HARNESS_PATH_GUIDANCE = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.';
export const HARNESS_CHECKOUT_GUIDANCE = 'The runtime context names the DeepSeek Harness implementation checkout. The checkout location and current working directory are separate values and may differ; never infer the working directory from the checkout path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.';
export const HARNESS_GUI_IDENTITY = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.';

export function portableHarnessGuidance(content: string): string {
  return content.split(/(\r?\n(?:\r?\n)+)/).map(paragraph => {
    if (paragraph === HARNESS_PATH_GUIDANCE) return paragraph
      .replace('Tokens prefixed with @', 'Tokens prefixed with the at sign (Unicode U+0040)')
      .replace('@"..." quotes a path containing spaces.', 'A U+0040 prefix followed by a double-quoted path denotes a path containing spaces.');
    if (paragraph === HARNESS_CHECKOUT_GUIDANCE) return paragraph
      .replace('DeepSeek Harness', 'local agent')
      .replace('inspect or extend DSH itself', 'inspect or extend the agent itself');
    if (paragraph === HARNESS_GUI_IDENTITY || paragraph.startsWith(HARNESS_GUI_IDENTITY + ' ') || paragraph.startsWith(HARNESS_GUI_IDENTITY + '\n') || paragraph.startsWith(HARNESS_GUI_IDENTITY + '\r\n')) {
      return HARNESS_GUI_IDENTITY.replace('DeepSeek Harness', 'local agent') + paragraph.slice(HARNESS_GUI_IDENTITY.length);
    }
    return paragraph;
  }).join('');
}
