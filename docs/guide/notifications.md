# Control notification sounds

Tau plays a short sound when a turn ends or when it needs your answer, and requests a desktop banner when the terminal is unfocused.

1. Open `~/.tau/settings.json`.
2. To disable sound and banners, add:

   ```jsonc
   { "notifications": { "enabled": false } }
   ```

   To keep banners and disable only the sound, use:

   ```jsonc
   { "notifications": { "sound": false } }
   ```

3. Restart Tau to apply the setting.

## What happens

Both settings default to `true`. Each live turn produces one alert, including runs stopped by a limit. Cancellation is silent. Tool calls, retries and restored history do not produce alerts.

The sound plays even while focused. When the terminal reports that it is unfocused, Tau also requests a banner titled “Tau”, with “Response ready” or “Run failed”. Tau also alerts you when it waits for your answer, for example the `/commit` review or push question. The banner reads “Input needed”. Several questions open at once produce one alert. Pickers you open yourself, such as `/model`, produce none. Banners do not include response text or error details. When focus is unknown, Tau plays only the sound. Print mode produces neither output.

The bundled sound is [“Intuition” by NotificationSounds.com](https://notificationsounds.com/notification-sounds/intuition-561), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Tau converts the full sound to WAV without trimming or adding a fade.

## Reloads

When you edit Tau's own code with `autoRestart` on, the end-of-turn alert waits until the reload settles, because the sound and banner should call you to something you can see. If the new code starts, the new Tau plays the sound. If the new code fails to build or start, the current Tau plays it next to the failure message. Without `autoRestart`, it plays at once. The new Tau does not know whether the terminal is focused, so after a reload it plays the sound but may not show a banner.

## Limits

Desktop banners depend on terminal support, notification permissions and OS settings. Tau uses the terminal’s notification protocol; it does not install a native notification helper. cmux, Ghostty, iTerm2, Kitty, WezTerm and other terminals provide notification protocols, but delivery must be verified in your terminal. Terminal.app banner delivery is unverified.

The terminal or OS can play its own sound alongside Tau’s sound. The sound setting controls Tau’s playback only.

Over SSH, banners can reach your local terminal, while Tau’s sound plays on the machine running Tau. A missing audio device or notification failure is logged and does not stop the run.
