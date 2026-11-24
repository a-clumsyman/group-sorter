# Group Sorter

A WhatsApp community helper that spots posts in the wrong group and either reminds the sender or moves the post to the right group, so admins don't have to police it by hand.

It was built for a community with one main group plus topic groups (jobs, events, grants), where people keep posting jobs in the events group or the main chat.

## How it works

1. The bot is linked to a spare WhatsApp number, the same way WhatsApp Web is linked.
2. It reads each new post in the groups you choose.
3. An AI model (Claude) decides what the post is about: one of your topics, or general chat.
4. If the post belongs in a different group, the bot does one of three things, depending on the mode you pick:

| Mode | What the bot does |
| --- | --- |
| Only keep a record | Sends nothing. Lists what it would have done on the setup page. This is the default. |
| Reply with a reminder | Replies to the post and asks the sender to share it in the right group. |
| Move the post | Reposts it in the right group with the sender's name, removes the original, and leaves a short note. |

Everything is configured on a local web page. There are no config files to edit.

## Before you start

- **Use a spare number.** WhatsApp does not officially support bots in existing community groups. This project uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library, which breaks WhatsApp's terms, so the bot's number can be restricted or banned. Never use a personal number.
- **Make the bot an admin** in every group it watches. Without admin rights it can still remind people, but it cannot remove posts.
- **You need an Anthropic API key.** Create one at [console.anthropic.com](https://console.anthropic.com) and add credit. Usage is pay-as-you-go: one short AI request per post checked.
- **The computer must stay on.** The bot only runs while its window is open and the computer is awake.

## Quick start

1. Install [Node.js](https://nodejs.org) version 20 or newer (the LTS download).
2. Unzip the folder. Double-click `Start on Windows.bat` or `Start on Mac.command`. The first start downloads dependencies, which takes a minute or two.
3. A setup page opens at `http://localhost:3210`. Follow its four steps:
   1. Scan the code with the spare phone (WhatsApp, Settings, Linked devices, Link a device).
   2. Paste the AI key. It is tested before it is saved.
   3. Choose which group belongs to each topic, and tick the other groups to check, such as the main group.
   4. Choose a mode and save.

The sign at the top of the page turns blue and reads "Watching N groups" once everything is in place.

From a terminal, the equivalent is:

```bash
npm ci
npm start
```

`READ ME FIRST.txt` has the same steps in plain language for a non-technical admin, plus troubleshooting.

## Recommended rollout

Leave the bot on "Only keep a record" for a day or two and read the activity list at the bottom of the page. If its calls look right, switch to "Reply with a reminder". Move to "Move the post" once you trust it.

## What the bot checks and what it ignores

Checked:

- Text posts of 20 characters or more.
- Images, with or without a caption. The image itself is shown to the AI, since job and event posts are often posters.
- Videos and files, judged by their caption and file name.
- WhatsApp event invitations.

Ignored, with no AI request made:

- Short messages, stickers, voice notes, reactions, polls, edits and deletions.
- The bot's own messages, and messages in groups you have not selected.
- Posts by group admins (this can be switched off on the setup page).
- Messages more than 10 minutes old, which can arrive in a batch after a reconnect.

## How a decision is made

- The AI returns every topic the post fits, best fit first, with a confidence between 0 and 1.
- General chat is always left alone, including inside topic groups. A question in the jobs group is not moved to the main group.
- A post that fits two topics is left alone if it is already in either topic's group.
- The bot acts only when confidence meets the threshold (default 0.8, adjustable on the page).
- A topic with no group assigned is never acted on.

## Safeguards

- **Repost before removing.** In move mode the original is removed only after the repost succeeds. If the repost fails, nothing is deleted.
- **Falls back to a reminder** in any group where the bot is not an admin.
- **Hourly cap.** At most 20 actions per hour by default, so a misjudgment cannot flood a group.
- **Human-like pacing.** A random pause of a few seconds before each action.
- **Pause button** on the setup page stops all checking without closing anything.
- **The message is treated as data.** The AI prompt tells the model never to follow instructions written inside a post.
- **Local-only page.** The setup page listens on `127.0.0.1` only and rejects requests from other websites. The saved API key is not sent back to the browser, apart from its last four characters so you can tell which key is in use.

## Settings

Everything on the setup page is saved to `data/settings.json`. A few values can only be changed in that file.

| Setting | Default | Notes |
| --- | --- | --- |
| `mode` | `watch` | `watch`, `nudge` or `move`. |
| `threshold` | `0.8` | Minimum AI confidence before acting. |
| `skipAdmins` | `true` | Leave admins' posts alone. |
| `topics` | Jobs, Events, Grants | Each has a name, a description of what belongs there, and a group. Up to 12. |
| `watchGroupIds` | none | Extra groups to check that are not a topic's home. |
| `model` | `claude-haiku-5-5` | Editable under "Wording and advanced settings". |
| `maxActionsPerHour` | `20` | File only. |
| `nudgeText`, `movedText`, `repostHeader` | see page | Message wordings. |

Wordings can use `{name}` for the sender, `{topic}` for the topic, `{group}` for the right group, and `{from}` for the group it was posted in.

The topic descriptions are part of the AI prompt. If the bot misjudges a kind of post, sharpening the description is usually the fix.

## Data and privacy

- The text and images of posts in the watched groups are sent to Anthropic's API for classification. Nothing else leaves the computer.
- `data/settings.json` holds the settings and the API key.
- `data/whatsapp-session/` holds the WhatsApp link. Anyone with this folder can act as the bot's number.
- `data/activity.jsonl` holds the activity record, including a short excerpt of each post checked.

Do not share or commit the `data` folder.

## Status

Tested:

- 44 automated tests covering sorting decisions, each mode, admin handling, limits, settings, the setup page's server, and connection recovery. They run against a stand-in WhatsApp connection and a stand-in AI service.
- The outgoing message formats (reply, forward, remove, image with caption) were checked against the Baileys message builder.
- The setup page was exercised in a real browser.
- A first-time start from a fresh unzip was run with the Mac start file on Linux.

Not yet tested:

- A live WhatsApp connection: linking, reading real group messages, sending and removing.
- The AI prompt against the real model.
- The Windows start file on a Windows machine.

Expect to watch the first day closely.

## Known limits

- Baileys tracks an unofficial protocol and can break when WhatsApp changes it. The version is pinned to `7.0.0-rc14`.
- One bot per number, on one computer. Running two copies makes them disconnect each other.
- If the bot's admin status in a group cannot be determined, it attempts the move anyway.
- Videos and files are judged by caption and file name only.

## Development

```bash
npm ci        # install
npm start     # run the bot and open the setup page
npm test      # run the test suite
```

| File | Purpose |
| --- | --- |
| `src/index.js` | Entry point. Starts the bot and the setup page. |
| `src/bot.js` | WhatsApp connection, reading posts, reminding and moving. |
| `src/classifier.js` | The AI request and its prompt. |
| `src/router.js` | The decision: is a post misplaced, and where does it go. |
| `src/extract.js` | Gets text and images out of WhatsApp messages. |
| `src/server.js` | Local server for the setup page. |
| `src/store.js` | Settings and activity record. |
| `public/index.html` | The setup page. |

Environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Port for the setup page. Default `3210`. |
| `GROUP_SORTER_DATA` | Location of the data folder. |
| `GROUP_SORTER_NO_BROWSER` | Set to `1` to stop the browser opening on start. |
| `ANTHROPIC_BASE_URL` | Override the AI service address, used by the tests. |

The start files restart the bot five seconds after a crash. Exit code `2` means "do not restart", used when the bot is already running or Node.js is too old.
