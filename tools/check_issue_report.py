"""Validate issue reports and close incomplete reports without executing issue text."""

import json
import os
import re
from pathlib import Path
from urllib.request import Request, urlopen

PERSONAL_ACCOUNT_ID = 7198316
HEADINGS = (
    "Detailed issue description",
    "Local troubleshooting without code modification",
    "Exact environment",
    "How to reproduce",
    "Direct supporting evidence",
    "Suspected causes",
)
AUTHORIZATION_HEADING = "Human authorization requirement"
ACKNOWLEDGMENT = (
    "Do NOT propose code changes without explicit human authorization. "
    "This issue authorizes investigation and reporting only; it does not authorize proposing or making code changes."
)


def report_errors(issue):
    """Check structure only; content accuracy still requires human review."""
    if issue["user"]["id"] == PERSONAL_ACCOUNT_ID:
        return []
    body = re.sub(r"<!--.*?-->", "", issue.get("body") or "", flags=re.DOTALL)
    sections = {}
    current = None
    fence = None
    duplicates = set()
    for line in body.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
                continue
            if current == AUTHORIZATION_HEADING:
                continue
        elif marker:
            fence = marker[1]
            continue
        elif line.startswith("### "):
            current = line[4:].strip()
            if current in sections:
                duplicates.add(current)
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append(line)

    errors = []
    for heading in (*HEADINGS, AUTHORIZATION_HEADING):
        if heading in duplicates:
            errors.append(f"Use exactly one '{heading}' section.")
    for heading in HEADINGS:
        content = "\n".join(sections.get(heading, []))
        normalized = re.sub(r"\W|_", "", content).casefold()
        if normalized in {"", "noresponse", "todo", "tbd"}:
            errors.append(f"Complete the '{heading}' section.")
    authorization = "\n".join(sections.get(AUTHORIZATION_HEADING, []))
    if not re.search(r"^\s*- \[[xX]\] " + re.escape(ACKNOWLEDGMENT) + r"\s*$", authorization, re.MULTILINE):
        errors.append("Include and check the full human authorization acknowledgment from the issue form.")
    return errors


def api(path, *, method="GET", data=None):
    """Use the workflow token; never include it in output or issue content."""
    request = Request(
        f"{os.environ.get('GITHUB_API_URL', 'https://api.github.com')}/{path}",
        method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "undertale-web-issue-format",
        },
    )
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def enforce(path):
    """Fetch current state so queued events do not act on outdated issue bodies."""
    issue = api(path)
    if issue["state"] != "open":
        return
    errors = report_errors(issue)
    if not errors:
        print("Issue meets the format requirement or belongs to the exempt personal account.")
        return
    repository = "/".join(path.split("/")[1:3])
    form_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repository}/issues/new?template=issue.yml"
    message = (
        "This issue does not meet the repository's required report format:\n\n"
        + "\n".join(f"- {error}" for error in errors)
        + f"\n\nPlease use the [issue form]({form_url}), or update this issue to match its headings and requirements, "
        "then reopen it. State unknowns and evidence gaps explicitly. "
        "Only the personal account `notmike101` is exempt; agent and other maintainer accounts must follow the form.\n\n"
        "Do NOT propose code changes without explicit human authorization. "
        "Filing an issue does not authorize proposing or making code changes."
    )
    api(f"{path}/comments", method="POST", data={"body": message})
    api(path, method="PATCH", data={"state": "closed", "state_reason": "not_planned"})
    print("Closed incomplete issue with an explanation and correction instructions.")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    number = int(event["issue"]["number"])
    enforce(f"repos/{os.environ['GITHUB_REPOSITORY']}/issues/{number}")
