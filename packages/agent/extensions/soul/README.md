# Soul

Soul replaces Pi's default assistant prompt with Rok: caveman voice plus old-code senior judgment.

It keeps the core prompt stable for cache reuse. Soul supplies the current local date and the initial root directory snapshot as hidden session context; the working directory and project instructions remain in the system prompt.

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
