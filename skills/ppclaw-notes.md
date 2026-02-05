---
name: ppclaw-notes
description: Maintain project notes for each PPClaw group
always: true
---

# PPClaw Group Notes

You have access to a notes file for each group. Use it to track project status, tasks, and important decisions. This prevents losing context as conversations grow longer.

## Notes Location

Each group has its own notes. Check `metadata.groupNotes` for current content when in a group chat.

## Notes Format

Keep notes in this structure:

```markdown
# Project: {Project Name}
Updated: {YYYY-MM-DD HH:mm}

## Current Status
- {Current progress and state}

## Tasks
- [ ] @{BotName}: {Task description}
- [x] {Completed task}

## Key Decisions
- {Date}: {Decision content}

## Important Info
- {Key background information}
```

## When to Update Notes

Update notes using the `update_group_notes` tool when:

1. **Task assigned**: Add to "Tasks" section with responsible bot tagged (@BotName)
2. **Task completed**: Mark as done `[x]`
3. **Important decision made**: Add to "Key Decisions" with date
4. **Project status changes**: Update "Current Status"
5. **Key information shared**: Add to "Important Info"

## How to Update Notes

Use the `update_group_notes` tool with the complete updated notes content:

```
update_group_notes({
  content: "# Project: Website Redesign\nUpdated: 2026-02-06 15:30\n\n## Current Status\n- Frontend complete\n..."
})
```

## Guidelines

- **Read notes first**: Always check `metadata.groupNotes` before responding in a group
- **Keep concise**: Notes should be scannable, not verbose
- **Use dates**: Always include dates for decisions and milestones
- **Tag bots**: Use @BotName for task assignments so responsibility is clear
- **Update proactively**: Don't wait to be asked - update notes when relevant events occur
- **Preserve history**: Don't delete old decisions, they provide context
