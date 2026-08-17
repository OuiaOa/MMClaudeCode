#!/usr/bin/env bash
# dsv4shim PreToolUse deny-list hook.
# Hard-blocks catastrophic commands in bypassPermissions mode (no other guardrail exists).
# stdin: hook JSON (tool_input.command is matched as raw text — the JSON layer escapes
# only quotes/backslashes, which cannot appear in the fragments below).
# exit 0 = allow, exit 2 = deny (blocked; stderr shown to the user).
set -u
input=$(cat)

# Recursive-force rm on a critical root (/, ~, $HOME, /home, /root, /etc, /usr, /bin,
# /boot, /dev, /var, /srv — with or without a trailing /*), or --no-preserve-root.
RM_FLAGS='rm[[:space:]]+(-[a-zA-Z]*[rf][a-zA-Z]*[rf][a-zA-Z]*|--[a-zA-Z-]*recursive[a-zA-Z-]*|-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*)'
RM_TARGET='(^|[^A-Za-z0-9_/])(/|/\*|/home(/\*)?|/root(/\*)?|/etc(/\*)?|/usr(/\*)?|/bin(/\*)?|/boot(/\*)?|/dev(/\*)?|/var(/\*)?|/srv(/\*)?|~(/\\*)?|\$HOME(/\*)?)([^A-Za-z0-9_/.]|$)'

if printf '%s' "$input" | grep -qE -- "$RM_FLAGS" && printf '%s' "$input" | grep -qE -- "$RM_TARGET"; then
  echo "deny-list: recursive force-delete of a critical root is blocked (would have run: $(printf '%s' "$input" | grep -oE '"command"[^,]*' | head -c 120))" >&2
  exit 2
fi
if printf '%s' "$input" | grep -q -- '--no-preserve-root'; then
  echo "deny-list: rm --no-preserve-root is blocked" >&2
  exit 2
fi

# dd writing to a raw block device.
if printf '%s' "$input" | grep -qE 'dd[[:space:]]+[^"]*\bof=/dev/(sd|hd|nvme|vd)[a-z]'; then
  echo "deny-list: dd to a raw block device is blocked" >&2
  exit 2
fi

# Filesystem creators.
if printf '%s' "$input" | grep -qE '\bmkfs(\.[a-zA-Z0-9]+)?[[:space:]]|mkswap[[:space:]]'; then
  echo "deny-list: mkfs/mkswap (filesystem creation) is blocked" >&2
  exit 2
fi

# Remote pipe-to-shell.
if printf '%s' "$input" | grep -qE '(curl|wget)[^"|;&<>]*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh([[:space:]]|$|")'; then
  echo "deny-list: remote pipe-to-shell (curl|sh) is blocked" >&2
  exit 2
fi

# Fork bomb.
if printf '%s' "$input" | grep -qE ':\(\)[[:space:]]*\{[^"]*:\|:'; then
  echo "deny-list: fork bomb is blocked" >&2
  exit 2
fi

exit 0
