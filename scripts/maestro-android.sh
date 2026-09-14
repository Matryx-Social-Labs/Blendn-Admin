#!/bin/bash
# Run a Maestro flow on Android and copy its screenshots out to /tmp/mflows.
#
# Maestro's own driver install fails silently on this emulator, and it
# uninstalls the driver at the end of a run -- so the NEXT run finds nothing and
# dies on `deviceInfo` ("Device server died ... UNAVAILABLE"). Keeping the two
# driver APKs installed ourselves makes runs deterministic. The APKs ship inside
# maestro-client.jar.
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$HOME/Library/Android/sdk/platform-tools:$PATH"
DEV="${DEVICE:-emulator-5554}"
JAR=/opt/homebrew/Cellar/maestro/2.10.0/libexec/lib/maestro-client.jar
cd /tmp/mflows || exit 1

ensure_driver() {
  # A defunct [.mobile.maestro] zombie from a killed run blocks the next
  # driver start; the symptom is 'Device server died during deviceInfo'.
  adb -s "$DEV" shell am force-stop dev.mobile.maestro >/dev/null 2>&1
  adb -s "$DEV" shell pm list packages 2>/dev/null | grep -q 'dev.mobile.maestro.test' && \
  adb -s "$DEV" shell pm list packages 2>/dev/null | grep -q 'dev.mobile.maestro$' && return 0
  [ -f maestro-app.apk ] || unzip -o -q "$JAR" maestro-app.apk maestro-server.apk
  adb -s "$DEV" install -r -g maestro-app.apk    >/dev/null 2>&1
  adb -s "$DEV" install -r -g maestro-server.apk >/dev/null 2>&1
}

ensure_driver
OUT=$(maestro --device "$DEV" test "$1" 2>&1 | grep -vE "^WARNING|^\s+at ")
if echo "$OUT" | grep -q "did not start up in time\|DeviceServerDied\|Device server died"; then
  echo "(driver died; reinstalling and retrying once)"
  ensure_driver
  OUT=$(maestro --device "$DEV" test "$1" 2>&1 | grep -vE "^WARNING|^\s+at ")
fi
echo "$OUT" | tail -20

D=$(ls -td ~/.maestro/tests/*/ | head -1)
find "$D" -name '*.png' 2>/dev/null | while read -r f; do
  n=$(basename "$f"); cp "$f" "/tmp/mflows/$n"
  sips -Z 760 "/tmp/mflows/$n" --out "/tmp/mflows/${n%.png}-s.png" >/dev/null 2>&1
  echo "  -> /tmp/mflows/${n%.png}-s.png"
done
