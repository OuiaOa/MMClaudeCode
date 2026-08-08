#!/bin/sh
# pre-push — blocks a push that would put runtime state, credentials, or local
# machine identifiers into this repo's history, regardless of what .gitignore says.
#
# Exists because .gitignore only stops NEW files from being tracked — it does
# nothing once a file is already tracked. This is the structural fix: nothing
# matching these patterns can leave the machine via `git push`, full stop.
#
# Bypass (only if you are certain a match is a false positive): git push --no-verify
#
# Test fixtures in this repo deliberately use placeholder-shaped paths and
# strings (C--Users-test, C:\Users\Test, /Users/test, sk-test-*) so a legitimate
# fixture is not expected to trip these patterns; a real value would.
#
# Git calls this with two args ($1=remote name, $2=remote URL) and feeds one
# line per ref on stdin: "<local ref> <local sha1> <remote ref> <remote sha1>"

blocked=0

# --- path patterns: the file itself is the problem, regardless of content ----
PATH_PATTERNS='usage\.jsonl$
balance\.json$
balance-history\.jsonl$
shim\.log$
shim\.pid$
^vision-cache/
^\.update-cache/
^\.installed-commit$
^\.last-update\.json$
^backups/
(^|/)config\.json$
(^|/)probe-results\.json$
(^|/)key$
(^|/)deepinfra-key$
(^|/)sentinel$
(^|/)\.env$
(^|/)id_rsa$
(^|/)id_ed25519$
\.pem$
\.pfx$
\.p12$'

# --- content patterns: real-looking credentials/PII in the file's added lines
CONTENT_PATTERNS='sk-[A-Za-z0-9_-]{20,}
gh[pousr]_[A-Za-z0-9]{20,}
AKIA[0-9A-Z]{16}
-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY
eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.
xox[baprs]-[A-Za-z0-9-]{10,}
AIza[0-9A-Za-z_-]{35}
DESKTOP-[A-Z0-9]{6,}
(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}'

# Windows profile path — checked separately, exempting this repo's own test
# fixtures BY PATH rather than by value. test-cli.mjs deliberately uses
# "C:\Users\User" as a placeholder, which happens to collide with this
# machine's real account name — a value-based allowlist for that string would
# blind the hook to a genuine leak using the same common name. Exempting the
# known fixture files by path avoids that coincidence entirely.
WIN_PATH_PATTERN='C:\\Users\\[A-Za-z0-9._-]+'

OLD_IFS="$IFS"

check_file_path() {
    path="$1"
    IFS='
'
    for pat in $PATH_PATTERNS; do
        [ -z "$pat" ] && continue
        if echo "$path" | grep -Eq "$pat"; then
            echo "  BLOCKED (path matches '$pat'): $path"
            blocked=1
        fi
    done
    IFS="$OLD_IFS"
}

check_content() {
    path="$1"
    added_lines="$2"
    [ -z "$added_lines" ] && return

    IFS='
'
    for pat in $CONTENT_PATTERNS; do
        [ -z "$pat" ] && continue
        hit=$(printf '%s\n' "$added_lines" | grep -Eo "$pat" 2>/dev/null | head -1)
        if [ -n "$hit" ]; then
            sample=$(echo "$hit" | cut -c1-24)
            echo "  BLOCKED (content matches credential/PII pattern): $path   [${sample}...]"
            blocked=1
        fi
    done
    IFS="$OLD_IFS"

    case "$path" in
        test-*.mjs|test-*.py|test-*.sh|*/tests/*|*/test/*|*/e2e/*|INSTALL.md|README.md)
            return ;;   # established fixture/doc zones, audited clean — see header comment
    esac
    win_hits=$(printf '%s\n' "$added_lines" | grep -Eo "$WIN_PATH_PATTERN" 2>/dev/null)
    if [ -n "$win_hits" ]; then
        hit=$(echo "$win_hits" | head -1 | cut -c1-24)
        echo "  BLOCKED (real Windows profile path): $path   [${hit}...]"
        blocked=1
    fi
}

ZERO="0000000000000000000000000000000000000000"

while read -r local_ref local_sha remote_ref remote_sha; do
    [ "$local_sha" = "$ZERO" ] && continue   # a branch delete, nothing to check

    if [ "$remote_sha" = "$ZERO" ]; then
        for f in $(git ls-tree -r --name-only "$local_sha"); do
            check_file_path "$f"
            case "$f" in
                *.jsonl|*.json|*.md|*.mjs|*.ps1|*.sh|*.vbs|*.cmd|*.py|*.yml|*.yaml|*.txt)
                    check_content "$f" "$(git show "$local_sha:$f" 2>/dev/null)"
                    ;;
            esac
        done
    else
        range="$remote_sha..$local_sha"
        for f in $(git diff --name-only --diff-filter=ACM "$range" 2>/dev/null); do
            check_file_path "$f"
            diff_added=$(git diff "$range" -- "$f" 2>/dev/null | grep -E '^\+' | grep -Ev '^\+\+\+')
            check_content "$f" "$diff_added"
        done
    fi
done

if [ "$blocked" -eq 1 ]; then
    echo ""
    echo "pre-push: refusing to push — one or more files above look like runtime"
    echo "state, a credential, or a local machine identifier. If this is a false"
    echo "positive (e.g. a deliberate test fixture), push with: git push --no-verify"
    exit 1
fi

exit 0
