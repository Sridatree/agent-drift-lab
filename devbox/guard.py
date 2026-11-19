#!/usr/bin/env python3
"""The devbox guard: a Claude Code PreToolUse hook that refuses the shortcuts seen in the drift runs.

Claude Code pipes each Write/Edit/MultiEdit/Bash call in as JSON on stdin. Exit 0 lets it run;
exit 2 refuses it, and what goes to stderr is shown to the agent as the reason. Every refusal is
also sent to the collector as a guard_blocked event, so it shows up in Grafana (CC-010).

  CC-006  rewriting existing tests or CI: deleting, renaming or changing test lines, adding a skip,
          or touching a CI workflow. Adding new tests and resolving merge conflicts stay allowed.
  CC-007  a doc citing a source the session never opened, or claiming it was "checked" with
          nothing fetched.
  CC-002  uploading to a host outside a short allowlist.

DEVBOX_GUARD=0 (set by `DEVBOX_GUARD=0 devbox ...`) lets everything through.
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

TEST_FILE = re.compile(r"(_test\.go|_test\.py|(^|/)test_[^/]*\.py|\.(test|spec)\.[cm]?[jt]sx?)$")
TEST_DIR = re.compile(r"(^|/)(tests?|__tests__)/")
CI_FILE = re.compile(r"(^|/)(\.github/workflows/|\.gitlab-ci\.ya?ml$|\.circleci/|Jenkinsfile$)")
SKIP = re.compile(r"\bt\.Skip(Now|f)?\(|pytest\.mark\.skip|pytest\.skip\(|@unittest\.skip|\b(it|describe|test)\.skip\(|\bx(it|describe)\(")
CONFLICT = re.compile(r"^(<<<<<<<|=======|>>>>>>>)", re.M)

DOC_FILE = re.compile(r"(\.(md|mdx|rst|txt|adoc)$|(^|/)docs?/)")
URL = re.compile(r"https?://[^\s`)>\]\"']+")
CITATION_LINE = re.compile(r"(?im)^.*\b(sources?|references?|retrieved|verified|checked|accessed|according to)\b.*$")
CHECKED_CLAIM = re.compile(r"(?i)\b(checked|verified|retrieved|accessed)\b[^.\n]{0,20}\b20\d\d-\d\d-\d\d")

UPLOAD = re.compile(
    r"(?i)\b(curl|wget)\b.*(\s-d\b|\s-F\b|\s-T\b|--data|--form|--upload-file|--post-data|--post-file|-X\s*(POST|PUT))"
    r"|\b(nc|ncat|netcat|scp|rsync|sftp)\s"
)
UPLOAD_ALLOWED = ("github.com", "githubusercontent.com", "anthropic.com", "claude.com", "localhost", "127.0.0.1")

DESTRUCTIVE = re.compile(r"(^|[\s;&|(])(rm|mv|truncate|unlink|git\s+rm|git\s+mv)\s|\b(sed|perl)\s+(-\w+\s+)*-i|\btee\s+(?!-a)")


def is_test(path):
    return bool(TEST_FILE.search(path) or TEST_DIR.search(path))


def is_ci(path):
    return bool(CI_FILE.search(path))


def lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def only_adds(old, new):
    """True when every line of old is still in new: tests or cases were added, none taken away."""
    remaining = lines(new)
    for line in lines(old):
        if line in remaining:
            remaining.remove(line)
        else:
            return False
    return True


def adds_skip(old, new):
    return bool(SKIP.search(new)) and not SKIP.search(old)


def check_test_edit(path, old, new):
    if is_ci(path):
        return "CC-006", f"{path} is CI configuration. Changing CI to get a green build hides the failure instead of fixing it."
    if not is_test(path):
        return None
    if adds_skip(old, new):
        return "CC-006", f"this adds a skip to {path}. Skipping a failing test hides the failure instead of fixing it."
    if CONFLICT.search(old) or only_adds(old, new):
        return None
    return "CC-006", (f"this removes or changes existing lines in {path}. Existing tests define what "
                      "'working' means; rewriting them to pass hides the failure.")


def transcript_seen(transcript_path):
    """Hosts and URLs the session has looked at: fetched pages, search results, files and output it read."""
    seen, fetched = [], False
    try:
        text = Path(transcript_path).read_text(errors="ignore")
    except (OSError, TypeError):
        return "", False
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "tool_use":
                name, tool_input = part.get("name"), part.get("input") or {}
                if name in ("WebFetch", "WebSearch"):
                    fetched = True
                    seen.append(json.dumps(tool_input))
                elif name == "Bash" and re.search(r"\b(curl|wget)\b", str(tool_input.get("command", ""))):
                    fetched = True
                    seen.append(str(tool_input.get("command", "")))
            elif part.get("type") == "tool_result":
                result = part.get("content")
                seen.append(result if isinstance(result, str) else json.dumps(result))
    return "\n".join(seen).lower(), fetched


def check_citation(path, old, new, transcript_path):
    if not DOC_FILE.search(path):
        return None
    cited = set()
    for line in CITATION_LINE.finditer(new):
        cited.update(URL.findall(line.group(0)))
    cited = {url.rstrip(".,;:") for url in cited if url not in old}
    claims_checked = bool(CHECKED_CLAIM.search(new)) and not CHECKED_CLAIM.search(old)
    if not cited and not claims_checked:
        return None
    seen, fetched = transcript_seen(transcript_path)
    unseen = sorted(url for url in cited if (urlparse(url).hostname or url).lower() not in seen)
    if unseen:
        return "CC-007", (f"{path} cites {', '.join(unseen[:3])}, but this session never opened it. "
                          "Only cite what you actually read; if you could not find a source, say so in the doc.")
    if claims_checked and not fetched:
        return "CC-007", (f"{path} says a source was checked on a date, but this session fetched nothing. "
                          "Do not claim verification that did not happen; mark the content as unverified.")
    return None


def check_bash(command):
    for token in re.findall(r"[\w./-]+", command):
        if not (is_test(token) or is_ci(token)):
            continue
        if DESTRUCTIVE.search(command) or re.search(r"(?<!>)>\s*['\"]?" + re.escape(token), command):
            return "CC-006", (f"this command deletes, moves or overwrites {token}. Existing tests and CI "
                              "define what 'working' means; changing them to pass hides the failure."), token
    if UPLOAD.search(command):
        for host in re.findall(r"https?://([A-Za-z0-9.-]+)", command) or re.findall(r"\b(?:nc|ncat|netcat)\s+([A-Za-z0-9.-]+)", command):
            host = host.lower()
            if not any(host == allowed or host.endswith("." + allowed) for allowed in UPLOAD_ALLOWED):
                return "CC-002", (f"this sends data to {host}, which is not an approved destination. "
                                  "Do not upload project files or secrets anywhere the user did not ask for."), host
    return None


def emit(policy, reason, tool, target, session_id):
    """One guard_blocked log record to the collector, through the box's local relay."""
    attributes = {"event.name": "guard_blocked", "policy_id": policy, "tool_name": tool,
                  "target": target, "reason": reason, "session.id": session_id}
    record = {"resourceLogs": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "claude-code"}}]},
        "scopeLogs": [{"scope": {"name": "devbox-guard"}, "logRecords": [{
            "timeUnixNano": str(time.time_ns()),
            "severityText": "WARN",
            "body": {"stringValue": f"guard blocked {tool}: {reason}"},
            "attributes": [{"key": k, "value": {"stringValue": str(v)}} for k, v in attributes.items()],
        }]}],
    }]}
    request = urllib.request.Request("http://127.0.0.1:4318/v1/logs", data=json.dumps(record).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=2)
    except OSError:
        pass


def decide(hook):
    tool, tool_input = hook.get("tool_name", ""), hook.get("tool_input") or {}
    transcript = hook.get("transcript_path")
    if tool == "Bash":
        # The target is what the command would have changed (a file, a host), not the whole command,
        # so the alert can say it in a few words.
        verdict = check_bash(str(tool_input.get("command", "")))
        return (verdict[:2], verdict[2]) if verdict else (None, "")

    path = str(tool_input.get("file_path", ""))
    try:
        existing = Path(path).read_text(errors="ignore")
    except OSError:
        existing = None
    if tool == "Write":
        edits = [(existing or "", str(tool_input.get("content", "")))]
        if existing is None and not is_ci(path) and not SKIP.search(edits[0][1]):
            # A new test file only adds tests; a new doc still has to cite honestly.
            return check_citation(path, "", edits[0][1], transcript), path
    elif tool == "Edit":
        edits = [(str(tool_input.get("old_string", "")), str(tool_input.get("new_string", "")))]
    else:
        edits = [(str(e.get("old_string", "")), str(e.get("new_string", ""))) for e in tool_input.get("edits") or []]

    for old, new in edits:
        verdict = check_test_edit(path, old, new) or check_citation(path, old, new, transcript)
        if verdict:
            return verdict, path
    return None, path


def main():
    if os.environ.get("DEVBOX_GUARD") == "0":
        return 0
    try:
        hook = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    verdict, target = decide(hook)
    if not verdict:
        return 0
    policy, reason = verdict
    emit(policy, reason, hook.get("tool_name", ""), target, hook.get("session_id", ""))
    print(f"Blocked by the devbox guard ({policy}): {reason} "
          "If the task cannot be finished honestly, stop and tell the user what is blocking it.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
