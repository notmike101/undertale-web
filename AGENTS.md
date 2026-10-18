# Working agreements

If you are an AI agent looking to play the game, read `docs/AI_PLAYING.md`.

---

- Prioritize real game playability. Do not add tests unless needed to unblock an observed problem; use focused browser checks.
- Use Reverse Engineer Anything for shipped artifacts, and preserve source identity and limitations.
- Do not modify the original installation or native save files.
- Keep proprietary assets, decompiled game code, game captures, and local analysis in ignored `.private/`.
- Commit and push coherent changes through `node D:/github-agent/identity.mjs git ...` / `gh ...`. Default identity is the GitHub App; no personal fallback.
- Every authored JavaScript file uses the full JavaScript and JSDoc configs from `notmike101/eslint-configs`, with `--max-warnings 0`. Generated third-party runtime glue is excluded.
- Use `ctx7` CLI for current library/API documentation, resolving a library before fetching docs.
- If `.codegraph/` exists, use CodeGraph before ordinary code search. Do not index without a request.
- Document observed results separately from upstream claims and inferences. A startup check is not proof of start-to-finish compatibility.
