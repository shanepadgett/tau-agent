# Notification sound

`notification.wav` contains the entire “Intuition” sound: 44,100 Hz, mono, 16-bit PCM WAV, 16,814 decoded frames (approximately 0.381 seconds).

Source: user-provided `intuition-561.ogg`. The original remains in the user’s Downloads folder. Conversion used macOS `afconvert` to decode the complete OGG file to PCM WAV. No trimming, added fade or gain adjustment was applied.

## Attribution and license

“Intuition” by [NotificationSounds.com](https://notificationsounds.com/notification-sounds/intuition-561), licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Converted from OGG to PCM WAV for Tau; the full sound is preserved.

The [sound page](https://notificationsounds.com/notification-sounds/intuition-561) identifies the Creative Commons Attribution license, and the [license page](https://notificationsounds.com/license) specifies CC BY 4.0 for all sounds (verified 2026-10-15). The license permits modification and redistribution, including commercial use, with attribution, a license link, and a description of changes. Include this credit in distributed third-party notices when the sound is bundled.

Tau imports the asset with Bun’s file loader. Standalone builds embed it in the executable, and the TUI reads its bytes into the native audio decoder on first playback. The standalone-binary decoding test has not yet run.
