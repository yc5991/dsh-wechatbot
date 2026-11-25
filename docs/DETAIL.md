# WeChat bot bridge

Read the chat open in the macOS WeChat client, draft a reply that sounds like a
person typing in the group, and send it. Everything uses OS-level accessibility
automation, clipboard selection and Apple's Vision OCR. Nothing is injected into
WeChat.

## Requirements

- macOS, with WeChat for Mac signed in.
- Grant **Accessibility** and **Screen Recording** to the process running DSH, in
  System Settings, Privacy & Security. Without them window reading returns
  permission errors, select-drag does nothing and OCR returns no lines.
- Prepare each target in a detached WeChat window. The overview marks a target
  ready when its window is on the left of the main display.
- Xcode command line tools for `swiftc`. Without them the OCR and drag helpers are
  interpreted with `swift`, which is slower but still works.

## Tools

| Tool | Purpose |
|---|---|
| `wechat_read` | Checks which messages from the current bot session are still visible. Group chats try select-copy with OCR fallback. Private chats use OCR. |
| `wechat_send` | Sanitize, verify the target group, then paste and send |
| `wechat_send_many` | Several bubbles with human pauses |
| `wechat_stickers` | Search labeled native favorites or submit one by its ID |
| `wechat_send_image` | Send an image by name or path |

Manage detection, settings, and sessions in the plugin detail panel.

## Vision and stickers

- When `attachScreenshot` is enabled and OCR locates the first message of a
  reply turn, the turn can include a downscaled image starting at that message.
  The panel preview starts only when requested. Its live
  mode pauses when the overview closes or the page goes into the background.
- Scan and label native favorites in the settings panel. Each submission opens
  the favorites picker and locates the original tile before clicking it. The
  local `wechat_send_image` tool accepts a filename or path for regular images.

## Configuration

Set these in the plugin's config row or from the plugin page panel.

| Key | Default | Meaning |
|---|---|---|
| `targets` | legacy single target | Up to ten exact chat names, each with a group or private mode |
| `atKeywords` | `["@豆包","豆包"]` | Tokens that count as an @-mention |
| `agentPreset` | `wechatbot` | Preset for bot sessions (no file, terminal or subagent tools) |
| `trigger.onNotification` | `true` | Listen for incoming system notifications |
| `dragCopyEnabled` | `true` | Allow group transcript selection and copy |
| `ocrEnabled` / `scan.intervalMinutes` | `true` / `5` | Read OCR text and optionally scan on an interval |
| `reuseWindowMinutes` | `3` | Messages within this quiet period share one session |
| `archiveAfterMinutes` | `5` | Silence after which the window is summarized and archived |
| `includeSessionMemory` | `false` | Let the model see summaries from earlier sessions |
| `dailyProactiveLimit` | `1000` | Daily cap shared by all sends and chats. 0 means unlimited. |
| `replyDelayMinSeconds` / `replyDelayMaxSeconds` | `0.8` / `2.4` | Random pause before sending |

## Prompt composition

- **First message of a conversation**: the full `AGENT.md`, `PERSONA.md` and every
  other `*.md` in the agent directory (except `MEMORY.md`), a one-line pointer to
  them, then the messages that opened the conversation and a bounded memory slice.
- **Every later message**: only the messages that just arrived plus the memory
  slice. The documents stay in the transcript, so they are paid for once per
  conversation instead of once per turn.
- The whole injection is capped by `maxPromptChars`; over budget, memory is
  dropped first and the message list is truncated from the oldest end.

## Target-group guard

The DSH session binds each tool invocation to one chat. The plugin serializes
WeChat actions and rechecks the foreground window before the final submit. Each
bubble in a batch is checked independently.

## Deliberate limits

- Select-copy reads only the visible region; older history needs scrolling first.
- Images and cards are read as whatever text OCR finds, not as content.
- The bot types through the user's own WeChat account.
- The next wake starts a new session if the old one was archived or detached.
  Permanent deletion of a local JSONL session is staged from the panel, executed
  after exiting DSH with an exclusive session lock, and verified on reopening.
