# glm-xhigh

Local Tau extension that keeps GLM 5.2 sessions on Pi's `xhigh` thinking level.

It only applies to these exact models:

- `fireworks/accounts/fireworks/models/glm-5p2`
- `zai/glm-5.2`
- `zai-coding-cn/glm-5.2`

When one of those models is active, the extension bumps thinking back to `xhigh` after session start, model changes, or manual thinking-level changes. If Pi clamps `xhigh` back down, it warns once and stops retrying until the model changes or extensions reload.
