# WeChat bot bridge

Zero-injection WeChat bot bridge for **macOS** and **Windows (WeChat 4.x)**, driven by ordinary DSH sessions with durable transcripts and memory.

Everything runs through OS-level window APIs, UI Automation, system notification stores, Vision / WinRT OCR, and clipboard automation — nothing is injected into the WeChat client. When WeChat enables window capture protection, **Capture-protected mode** keeps reading and sending working without pixels.

## Requirements

- **macOS**:
  - WeChat for Mac signed in.
  - Grant **Accessibility** and **Screen Recording** to `DeepSeek Harness` in System Settings → Privacy & Security.
  - Optional Xcode Command Line Tools (`swiftc`) to precompile Swift helpers.
- **Windows**:
  - WeChat 4.x (`Weixin.exe`) signed in.
  - Built-in `.NET Framework 4.x` (`csc.exe`) and PowerShell (pre-installed on Windows 10/11).
  - Enable system notifications in WeChat settings if you want instant toast triggers alongside scheduled scans.
- Open each target chat in its own **detached WeChat window**. Overview marks a target ready once its detached window is positioned on the left half of the main display.

## Tools

| Tool | Purpose |
|---|---|
| `wechat_read` | Verify visible messages belonging to the current session. Windows tries UIA first; group chats try drag-copy with OCR fallback; capture-protected mode skips screenshots. |
| `wechat_send` | Sanitize text, verify the foreground target window, then paste and send |
| `wechat_send_many` | Send multiple short bubbles with human-like pauses |
| `wechat_stickers` | Search labeled native WeChat favorites or click-send one by ID |
| `wechat_send_image` | Send an image from the bot's local `stickers/` directory |

## Vision, stickers, and capture-protected mode

- **Capture-protected mode**: Toggle **Capture-protected mode** directly in Overview → **WeChat window preview** (also auto-detected when OS window sharing state is `0` / `WDA_EXCLUDEFROMCAPTURE`). When active, window screenshots, OCR, per-turn image attachments, and composer pixel checks are bypassed; target verification relies on the detached window's native title, and group reads use geometry-based drag-copy (plus UIA on Windows).
- **Per-turn vision**: When `attachScreenshot` is enabled and capture-protected mode is off, turns include a downscaled capture starting from the first matched message of the batch.
- **Native favorites**: Sync WeChat favorites in **Bot settings → Stickers**, auto-label them with DSH vision, edit tags manually, and click-send from the native picker.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `targets` | `[]` | Up to 10 chat targets, each configured as `group` or `private` |
| `captureProtected` | `false` | Bypass all screenshots, OCR, and composer image checks |
| `atKeywords` | `["@豆包","豆包"]` | Mention tokens that wake the bot in group chats |
| `agentPreset` | `wechatbot` | Minimal-privilege preset for bot sessions (no file, shell, or subagent tools) |
| `trigger.onNotification` | `true` | Watch OS notification database for incoming messages |
| `dragCopyEnabled` | `true` | Allow group transcript drag-selection and clipboard copy |
| `ocrEnabled` / `scan.intervalMinutes` | `true` / `5` | Allow OCR reads and periodic background scans |
| `reuseWindowMinutes` | `3` | Quiet window within which new messages join the active session |
| `archiveAfterMinutes` | `5` | Silence threshold before summarizing into `MEMORY.md` and archiving |
| `includeSessionMemory` | `false` | Inject summaries from earlier sessions into new conversations |
| `dailyProactiveLimit` | `1000` | Daily send cap shared across all chats (`0` = unlimited) |
| `replyDelayMinSeconds` / `replyDelayMaxSeconds` | `0.8` / `2.4` | Random composing pause before sending |

## Prompt composition & safety

- **First turn of a session**: injects `AGENT.md`, `PERSONA.md`, and any extra `*.md` role files in the agent directory (excluding `MEMORY.md`), followed by incoming messages and optional memory.
- **Subsequent turns**: injects only newly arrived messages and optional memory, avoiding repeated system prompt cost.
- **Foreground & path guards**: every WeChat action is serialized and re-verifies window ID, foreground focus, native title, and coordinates right before paste and submit; `wechat_send_image` resolves symlinks and restricts files strictly to `<agentDir>/stickers`.
