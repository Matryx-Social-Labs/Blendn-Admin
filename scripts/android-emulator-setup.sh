#!/bin/bash
# Post-boot setup for the Blendn Android emulator (Blendn_GApis).
# Each line fixes something measured; see docs/agents/reference/environment.md.
set -u
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"

adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do :; done
# system_server registers ~290 services; fewer means it is still coming up (or crashed).
until [ "$(adb shell service list 2>/dev/null | wc -l | tr -d ' ')" -gt 250 ]; do :; done

# userfaultfd GC makes EVERY process start time out (~20s) on this image, which is
# what kills Maestro's driver mid-`inputText`. Must be set before zygote starts, so
# this only takes effect on the NEXT boot -- and device_config re-syncs its own store
# at boot unless sync is disabled, which is why both lines are here.
adb root >/dev/null 2>&1
until adb shell true >/dev/null 2>&1; do :; done
adb shell device_config set_sync_disabled_for_tests persistent >/dev/null 2>&1
adb shell device_config put runtime_native_boot enable_uffd_gc false >/dev/null 2>&1
adb shell setprop persist.device_config.runtime_native_boot.enable_uffd_gc false >/dev/null 2>&1
adb unroot >/dev/null 2>&1   # Maestro's driver breaks under a root adbd
until adb shell true >/dev/null 2>&1; do :; done

for k in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$k" 0
done
adb shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
adb shell input keyevent KEYCODE_MENU   >/dev/null 2>&1   # dismiss lock screen
adb reverse tcp:8081 tcp:8081 >/dev/null                  # Metro

echo "uffd_gc=$(adb shell getprop persist.device_config.runtime_native_boot.enable_uffd_gc)"
echo "services=$(adb shell service list 2>/dev/null | wc -l | tr -d ' ')"
echo "setup done (uffd takes effect on the next emulator restart)"
