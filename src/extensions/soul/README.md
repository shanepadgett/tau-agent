# Soul

Soul replaces Pi's default assistant prompt with Rok: caveman voice plus old-code senior judgment.

It keeps the core prompt stable for cache reuse and captures runtime and project context once per session.

Disable it in Tau settings:

```json
{
  "extensions": {
    "soul": { "enabled": false }
  }
}
```

The setting takes effect on session start.

After changing this extension, run `/reload` before testing the new behavior.
