# Changelog

## Unreleased

- Log in once with `rosebud login`: the person approves a private link, with no API key to copy. `rosebud whoami` shows the login's status and the person's credit balance, and `rosebud logout` revokes it.
- Make game assets with the person's Rosebud credits: `rosebud assets models`, `quote`, `create`, `status`, `list` and `download`. `create` refuses quotes above `--max-credits`, waits for the job, saves the file with `--out`, and resumes the same job when you rerun an interrupted command.

## 0.1.0

First public release.

- Publish a browser-ready build folder or ZIP with `rosebud publish` to get a play link and a private claim link. Unclaimed games are deleted after one hour.
- Approve updates once with `rosebud connect`, then ship new builds to the same link with `rosebud update`. Check access with `rosebud status` and revoke it with `rosebud disconnect`.
- Upload HTML, JavaScript, CSS, JSON, text notices, images, audio, fonts, WebAssembly and 3D models (GLB/glTF), up to 10 MiB zipped.
- Works on macOS, Linux and Windows with Node.js 22 or later.
- Licensed under Apache-2.0.
