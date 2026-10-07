# Android worker

Kotlin app that registers with the API, heartbeats, claims jobs, and runs `WePlayWorkflow`.

Android Studio is not required. Use the USB-attached device and `adb`.

## Device inspection (done)

Attached Oppo CPH2083 (`ORLVGMSCQC5DW4QG`), Android 9 / API 28.

- WePlay package: `com.wejoy.weplay.ar` 6.4.5
- Already logged in; launcher `StartActivity` goes straight to `MainActivity`
- Voice Room tab was open
- Search icon `search_room_imv` opens a dialog: Room ID / User ID, placeholder "Search Room", Cancel / Confirm
- `adb shell uiautomator dump` fails on this ColorOS build (`null root node`)
- Resource IDs from `dumpsys activity top` are in `WePlaySelectors.kt`

In-room Support is not mapped yet, so the adapter still reports `AUTOMATION_NOT_INSPECTED` and never success.

## API URL on a physical phone

Do not use `10.0.2.2` (emulator only). Use the Mac LAN IP, currently `192.168.18.36`:

```
sdk.dir=/Users/YOU/Library/Android/sdk
API_BASE_URL=http://192.168.18.36:3001
```
