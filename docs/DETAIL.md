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
- Keep the target chat open in its own window (or as the foreground chat of the
  main window). A detached chat window is preferred: its title is the exact group
  name, which also makes target verification cheap.
- Xcode command line tools for `swiftc`. Without them the OCR and drag helpers are
  interpreted with `swift`, which is slower but still works.

## Tools

| Tool | Purpose |
|---|---|
| `wechat_read` | Group chats try select-copy with OCR fallback. Private chats use OCR. Choose `mode="ocr"` for a background read or `mode="copy"` for exact group copy. |
| `wechat_send` | Sanitize, verify the target group, then paste and send |
| `wechat_send_many` | Several bubbles with human pauses |
| `wechat_stickers` | List image files in the sticker folder |
| `wechat_send_image` | Send an image by name or path |

Manage detection, settings, and sessions in the plugin detail panel.

## Vision and stickers

- When `attachScreenshot` is enabled, a reply turn can include a downscaled
  image of the chat pane. The panel preview starts only when requested. Its live
  mode pauses when the overview closes or the page goes into the background.
- `wechat_stickers` lists images in the sticker folder
  (`~/.dsh/dsh-wechatbot/stickers` by default) and `wechat_send_image` sends one
  by name or absolute path. The file goes onto the clipboard as picture data; the
  input box is verified to have changed before Return is pressed.

## Configuration

Set these in the plugin's config row or from the plugin page panel.

| Key | Default | Meaning |
|---|---|---|
| `expectedGroup` | `''` | Exact chat name to work in (group or private contact). Sends are refused while unset. |
| `chatMode` | `group` | `group` answers mentions/topics only; `private` answers every message |
| `whitelistGroups` | `[]` | Additional acceptable group names |
| `atKeywords` | `["@豆包","豆包"]` | Tokens that count as an @-mention |
| `agentPreset` | `wechatbot` | Preset for bot sessions (no file, terminal or subagent tools) |
| `scan.intervalMinutes` | `5` | Fallback screen scan interval |
| `reuseWindowMinutes` | `3` | Messages within this quiet period share one session |
| `archiveAfterMinutes` | `5` | Silence after which the window is summarized and archived |
| `dailyProactiveLimit` | `1000` | Daily cap on replies that are not @-mentions. 0 means unlimited. |
| `maxEmojiPerMessage` | `1` | Emoji cap per message |
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

`wechat_send` re-reads the window title immediately before sending and refuses
when the detected group is not `expectedGroup`. Pinning the group chat keeps the
window on that chat and makes the guard cheap to satisfy. A send still verifies
each time, because another chat can be opened while the model is thinking.

## Deliberate limits

- Select-copy reads only the visible region; older history needs scrolling first.
- Images and cards are read as whatever text OCR finds, not as content.
- The bot types through the user's own WeChat account.
- A session archived outside the plugin is detected and replaced on the next
  wake; prompts admitted to an archived session are dropped by DSH.
