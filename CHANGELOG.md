# Changelog

## Unreleased

- Log in once with `rosebud login`: the person approves a private link, with no API key to copy. `rosebud whoami` shows the login's status and the person's credit balance, and `rosebud logout` revokes it.
- Make game assets with the person's Rosebud credits: `rosebud assets models`, `quote`, `create`, `status`, `list` and `download`. `create` refuses quotes above `--max-credits`, waits for the job, saves the file with `--out`, and resumes the same job when you rerun an interrupted command.
- After `rosebud login` is approved, `rosebud publish` puts the game straight into the person's account and saves the update connection: no claim link and no `rosebud connect`.
- Throttled asset requests wait out Rosebud's `Retry-After` and send again, for up to a minute; longer waits report `retry_after_seconds`.
- `rosebud pull` brings a game's current files, including edits made in Rosebud, into a folder, keeping local edits and listing conflicts. It needs the owner's plan to include code download.
- Media now uploads file by file, so games are no longer limited to a 10 MiB ZIP. The limits are 19 MiB per file, and 2,000 files and 1 GiB per game. Files Rosebud already has aren't uploaded again.
- Text files may have any name the Rosebud editor allows, such as Markdown notes.
- Update conflicts list the files that changed (`changed_paths`), and errors suggest a `next_action`.
- A busy Rosebud (HTTP 503 `busy`) is reported as a rejection that changed nothing, with `retry_after_seconds`; run the same command again, or change your files first. While `assets create` waits for a job, busy answers are waited out. Upload sessions are asked for again automatically while Rosebud checks a game's existing files.

## 0.1.0

First public release.

- Publish a browser-ready build folder or ZIP with `rosebud publish` to get a play link and a private claim link. Unclaimed games are deleted after one hour.
- Approve updates once with `rosebud connect`, then ship new builds to the same link with `rosebud update`. Check access with `rosebud status` and revoke it with `rosebud disconnect`.
- Upload HTML, JavaScript, CSS, JSON, text notices, images, audio, fonts, WebAssembly and 3D models (GLB/glTF), up to 10 MiB zipped.
- Works on macOS, Linux and Windows with Node.js 22 or later.
- Licensed under Apache-2.0.
