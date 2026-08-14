# Soul

Soul is the baseline Tau system prompt. It is always on.

- **communication style** — short Slack-style replies, exact technical names, and a few worked examples.
- **operating model** — answer questions before acting, keep research tight and documentation-first, plan in small steps, and stop when a fix needs unusual force.
- **code style** — fast when the user is proving an idea, small and clean when the user wants real product code.
- **primary-directive overseer** — after 20 tool calls, privately checks whether long-running work still follows the user's request and the normal supported path. Any guidance is applied silently on the next model turn.

Pi continues to own tool guidance, project instructions, skills, documentation paths, custom prompts, and working-directory context.

Set `extensions.soul.overseer.enabled` to turn the overseer on or off. Set `extensions.soul.overseer.toolCallInterval` from 1 to 100 to change its review interval.

After changing this extension, run `/reload` before testing the new behavior.
