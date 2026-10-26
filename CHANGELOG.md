# Changelog

## Unreleased

- Log in once with `rosebud login`: the person approves a private link, with no API key to copy. `rosebud whoami` shows the login's status and the person's credit balance, and `rosebud logout` revokes it.
- Make game assets with the person's Rosebud credits: `rosebud assets models`, `quote`, `create`, `status`, `list` and `download`. `create` refuses quotes above `--max-credits`, waits for the job, saves the file with `--out`, and resumes the same job when you rerun an interrupted command.
- After `rosebud login` is approved, `rosebud publish` puts the game straight into the person's account and saves the update connection: no claim link and no `rosebud connect`.
- Throttled asset requests wait out Rosebud's `Retry-After` and send again, for up to a minute; longer waits report `retry_after_seconds`.
- `rosebud pull` brings a game's current files, including edits made in Rosebud, into a folder, keeping local edits and listing conflicts. It needs the owner's plan to include code download. If a file it would replace or remove changes while it downloads, it stops with `folder_changed` before changing the folder; run it again.
- `rosebud pull` lists under `missing_locally` the files Rosebud and the last sync have but the folder lacks, and says that the next update removes them from the game; `--force` restores them. The last sync belongs to its folder: pulling into another folder, or into an empty or missing one, writes every file.
- After a pull that reported conflicts, `rosebud update` refuses with `pull_conflicts` until a pull reports none or `--expected-version` names the version merged against, and an update from another folder than the last sync's refuses with `directory_mismatch`; both say what to run.
- `rosebud pull` compares names the way the disk does, so on macOS and Windows a name that differs only by letter case (or, on macOS, by Unicode form) is the same file and its local edits are kept. It never lets one name replace another: Rosebud's `foo.js` against your `Foo.js` is a `case_conflict`, and two Rosebud names that would land on one file or folder here (`Foo.js` and `foo.js`, `Scripts/` and `scripts/`) are each a `name_collision` that pull doesn't write. `clashes_with` names the other side, Rosebud's copies go to the `.remote` folder, and `next_action` says what to rename.
- Media now uploads file by file, so games are no longer limited to a 10 MiB ZIP. The limits are 19 MiB per file, and 2,000 files and 1 GiB per game. Files Rosebud already has aren't uploaded again.
- Text files may have any name the Rosebud editor allows, such as Markdown notes, except hidden names, names of only spaces and names with `< > : " | ? * / \` or control characters. Names ending in `.env` are excluded as credentials, in any case and ignoring surrounding spaces.
- OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is skipped when packing and pulling, never uploaded and never an error. Other hidden files are still refused.
- `.svg` and `.gltf` files outside `assets/` are text. A path Rosebud holds as text, such as an `assets/icon.svg` that Rosie wrote, stays text when you update, and media Rosebud already holds stays media, even when the folder spells the name in another Unicode form: it goes up under Rosebud's spelling. New media names go up in Unicode NFC, and two local names that are one name in NFC are refused with `duplicate_path`.
- Update conflicts list the files that changed (`changed_paths`, up to 4,000 paths), and errors suggest a `next_action`.
- A busy Rosebud (HTTP 503 `busy`) is reported as a rejection that changed nothing, with `retry_after_seconds`; run the same command again, or change your files first unless an earlier update is still uncertain. While `assets create` waits for a job, busy answers are waited out. Upload sessions are asked for again automatically while Rosebud checks a game's existing files, for as long as its `remaining` count keeps falling.
- A command stopped with Ctrl+C or SIGTERM releases its state lock and exits 130 or 143 with the error code `interrupted`, and a lock left by a process that no longer runs is taken over, so a rerun after an agent's timeout isn't refused.
- A Rosebud server without file sync (HTTP 503 `sync_unavailable`) is reported as a rejection (exit 3), and a failure while asking for an upload session says nothing was released.
- Signed uploads send whatever headers Rosebud's session lists, except credentials and connection headers, so storage can add signed headers without breaking uploads.
- On Windows, `rosebud pull` skips names Windows can't keep (a trailing dot or space, or device names such as `con.js`) as `unsafe_path`, and pull warns about hidden files in the folder, which `update` refuses.
- Logins carry scopes and expire after 90 days without use. `rosebud whoami` shows `scopes` and `expires_at`. An expired login fails with `key_expired`, and a login without a needed permission fails with `insufficient_scope` and its `required_scope`; both carry a `next_action`, which for `assets create` says to rerun the identical command once the person approves the new login.

## 0.1.0

First public release.

- Publish a browser-ready build folder or ZIP with `rosebud publish` to get a play link and a private claim link. Unclaimed games are deleted after one hour.
- Approve updates once with `rosebud connect`, then ship new builds to the same link with `rosebud update`. Check access with `rosebud status` and revoke it with `rosebud disconnect`.
- Upload HTML, JavaScript, CSS, JSON, text notices, images, audio, fonts, WebAssembly and 3D models (GLB/glTF), up to 10 MiB zipped.
- Works on macOS, Linux and Windows with Node.js 22 or later.
- Licensed under Apache-2.0.
