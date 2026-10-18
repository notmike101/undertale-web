"""Focused checks for the issue format gate; no GitHub writes or credentials."""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from check_issue_report import ACKNOWLEDGMENT, HEADINGS, enforce, report_errors


def report(body=None, author_id=123, state="open"):
    if body is None:
        body = "\n\n".join(f"### {heading}\n\nObserved details for this section."
                             for heading in HEADINGS)
        body += f"\n\n### Human authorization requirement\n\n- [x] {ACKNOWLEDGMENT}"
    return {"body": body, "user": {"id": author_id}, "state": state}


def check_reports():
    template = (Path(__file__).resolve().parents[1] / ".github/ISSUE_TEMPLATE/issue.yml").read_text(encoding="utf-8")
    for heading in (*HEADINGS, "Human authorization requirement"):
        assert f"      label: {heading}\n" in template, "Keep the form and validator synchronized"
    assert f'- label: "{ACKNOWLEDGMENT}"' in template
    valid = report()
    assert report_errors(valid) == []
    assert report_errors(report("", author_id=7198316)) == []
    assert report_errors(report(""))
    assert report_errors(report(valid["body"].replace("[x]", "[ ]")))
    assert report_errors(report(valid["body"].replace("[x]", "[X]"))) == []
    assert report_errors(report(valid["body"].replace(ACKNOWLEDGMENT, "I agree")))
    assert report_errors(report(valid["body"].replace(f"### {HEADINGS[0]}", "### Wrong title")))
    assert report_errors(report(valid["body"] + f"\n### {HEADINGS[0]}\nDuplicate"))
    for placeholder in ("", "_No response_", "TODO", "<!-- hidden content -->"):
        broken = valid["body"].replace("Observed details for this section.", placeholder, 1)
        assert report_errors(report(broken)), placeholder
    assert report_errors(report("```markdown\n" + valid["body"] + "\n```"))
    assert report_errors(report("<!--\n" + valid["body"] + "\n-->"))
    fenced_ack = valid["body"].replace(f"- [x] {ACKNOWLEDGMENT}", f"```text\n- [x] {ACKNOWLEDGMENT}\n```")
    assert report_errors(report(fenced_ack))
    evidence = valid["body"].replace("Observed details for this section.",
                                     "```text\n### Not a field\nactual error\n```", 1)
    assert report_errors(report(evidence)) == []
    assert report_errors(report(valid["body"].replace("Observed details for this section.", "Unknown"))) == []


def check_enforcement():
    with patch("check_issue_report.api") as api:
        api.return_value = report()
        enforce("repos/example/repo/issues/1")
        assert api.call_count == 1
    with patch("check_issue_report.api") as api:
        api.return_value = report("", author_id=7198316)
        enforce("repos/example/repo/issues/1")
        assert api.call_count == 1
    with patch("check_issue_report.api") as api:
        api.return_value = report("", state="closed")
        enforce("repos/example/repo/issues/1")
        assert api.call_count == 1
    with patch("check_issue_report.api") as api:
        api.return_value = report("")
        enforce("repos/example/repo/issues/1")
        calls = api.call_args_list
        assert len(calls) == 3
        assert calls[1].args[0].endswith("/comments")
        assert calls[1].kwargs["method"] == "POST"
        assert calls[2].kwargs["data"] == {"state": "closed", "state_reason": "not_planned"}
    with patch("check_issue_report.api") as api:
        api.side_effect = [report(""), RuntimeError("Comment failed")]
        try:
            enforce("repos/example/repo/issues/1")
        except RuntimeError:
            pass
        else:
            raise AssertionError("API failure was hidden")
        assert api.call_count == 2, "Do not close without the explanation"


if __name__ == "__main__":
    check_reports()
    check_enforcement()
    print("PASS: issue validation, personal exemption, API operations, and failure handling")
