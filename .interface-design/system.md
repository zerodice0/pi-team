# pi-team interface system

Terminal UI for watching agent teams while the user keeps working: the side panel (`panel.ts`)
and the team board overlay (`board.ts`). Both draw through `frame.ts`; change values there.

## Direction

- A quiet instrument in a dark control room. The user glances at it between prompts, so state
  must read at a squint and nothing may shout.
- The board is the panel's larger sibling: same surface, same border, same palette.
- Depth strategy: borders only, on a flat panel surface. No shadows or surface steps.

## Palette (`frame.ts` `palette`)

| Token | Hex | Use |
|---|---|---|
| panel | `#151820` | Surface behind every row (`BG`) |
| border | `#2a3038` | Frame, dividers. Never text. |
| title | `#d4c090` | Product name, active tab, selection rail, summary headings. The only accent. |
| name | `#e8ecf4` | Primary text: team names, roles, selected goal, busy activity |
| label | `#9ca3b0` | Secondary text: descriptions, paths, counts, idle activity |
| dim | `#6b7280` | Rails, table headers, tab separators. Not for content that must be read. |
| ok | `#00b4ff` | working |
| good | `#00ff88` | done, delivered |
| warn | `#ffb347` | waiting, stale, fallback model |
| crit | `#ff4757` | failed, undelivered, load errors |

Color only carries state. Gold marks "this is pi-team" and "this is what you chose".

## Glyphs

- States: working `▶`, waiting `◆`, idle `○`, done `✓`, failed `✗`, stopped `■`, stale `!`, starting `…`.
- Frame: `╭ ╮ ╰ ╯ ─ │` only. `├ ┤ ↳ ◌` fall back to other fonts and break; divide with plain rules.
- Selection rail: `▌` in title gold.

## Layout rules

- One space of padding inside each border (`row()`), blank row under the top edge and above the bottom edge.
- Labels live in the edges: top edge holds the title (left) and tabs or counts (right);
  the board's bottom edge holds key hints (left) and the scroll position (right).
- Key hints: key in `name`, action in `label`, separated by two spaces.
- Fixed board height (`rows - 2`, 12 to 40) so switching views or teams never resizes the frame.
- Truncate with `clip()` (keeps the background); never `truncateToWidth()`, which resets it.
- Every line of a frame must have the same `visibleWidth`; check it in tests, not in a browser
  screenshot, because browsers draw Hangul and emoji at other widths.

## Components

- Team title: every surface names a team by icon + title (`teamLabel`, `teamTitle`): the title given at
  start, else the goal's first sentence, else the ID. The ID, preset and alias appear only on the board.
- Team card (board Teams view): status glyph, bold icon + title; right: headline summary. Goal (2 lines,
  bright only when selected, without the sentence used as title), `id · preset · alias` line, counts line,
  worktree · branch line.
  Cards are separated by a blank row, not a rule.
- Roster (board Team view): ROLE, MEMBER (only when a key differs from its role), STATE, NOW,
  MODEL, MAIL, TOKENS. Headers in `dim` capitals; columns sized to content; NOW shows `—` when it
  would repeat the state.
- Thread (board Messages view): first message bold `from → to` and subject; replies indented four
  more columns; right side shows delivery state and `HH:MM`.
- Panel team block (60 columns): headline row (icon + title only), goal (2 lines, 1 when done), up to 5 live members, a folded
  "N finished" line, latest mail. Teams separated by a plain rule.
- `headline()` is the single reading of a team's state; reuse it on every surface.
