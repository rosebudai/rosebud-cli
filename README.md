# Rosebud CLI: publish and keep updating your game

Publish a browser-ready game from your terminal or coding agent. Rosebud packages your build, gives you a playable link and saves the project for later updates. Connect the game to its owner once, then keep shipping to the same link.

Requires Node.js 22+ and npm. Rosebud is built in as the publishing destination; no environment configuration is needed.

## For coding agents

Use the `rosebud` command to publish. Build and test the game locally, then publish it once with a useful title and description. If `rosebud whoami` shows an active login, the game goes straight into that person's account: there is nothing to claim or connect, and `rosebud update` works at once. Otherwise, run `rosebud connect` and give the private approval link to the person, who signs in and explicitly approves access to this game. On later sessions, use the saved project and `rosebud update`. A connection or update error is a reason to inspect `rosebud status`, not to create another project.

The CLI handles packaging, credentials, the saved project handle and update operation IDs. Run commands from the same project directory, or consistently pass `--state /private/path/project.json`. Keep terminal results private because they can contain claim and approval links.

To keep working on a game the person made in the Rosebud editor, follow [Work on a game made in Rosebud](#work-on-a-game-made-in-rosebud). To make art, audio or 3D models for the game, run `rosebud login` once and follow [Make assets](#make-assets).

## Quickstart

Install the CLI once:

```sh
npm install --global @rosebudai/cli
```

Or run it without installing: `npx @rosebudai/cli <command>`.

From your game project, publish its browser-ready build:

```sh
rosebud publish --directory ./dist \
  --title 'Moon Garden' \
  --description 'Collect five glowing seeds.'
rosebud connect
```

No build step? Copy the files your game needs (`index.html` and everything it loads) into a folder such as `./dist` and publish that, not the project root: the CLI keeps its state in `.rosebud/` there, and hidden files can't be uploaded.

For the supplied sample, use `--directory ./examples/signal-garden`. For an existing archive, use `--zip ./game.zip`. Add `--thumbnail ./cover.png` to supply a gameplay screenshot; omitting it keeps the existing placeholder.

`publish` creates a game and saves `.rosebud/project.json` outside the build directory. With an active `rosebud login`, the game goes straight into that person's account: the result has `claimed: true`, the `owner` and an `editor_url`, the update connection is saved, and you skip `connect`. Without a login, the JSON result includes a public `play_url` and private `claim_url`. `connect` returns a private `approval_url`: give it to the intended owner, who signs in and explicitly approves permission to update this one game. An unclaimed game can be claimed and connected in the same action. Visiting the link or signing in alone does not approve access.

After the person approves, and whenever a later agent session returns:

```sh
rosebud status
# Build your next version into dist.
rosebud update --directory ./dist
```

Keep `.rosebud/` out of Git. Credentials are stored separately in `~/.config/rosebud/credentials`, with private directory/file permissions. `ROSEBUD_CREDENTIALS_DIR` selects another private directory. The saved handle survives rebuilding `dist`, and credentials are bound to the project's API origin.

On a new machine, run `rosebud connect --project <project_id>` and have the owner approve the new connection. Run `rosebud status` after approval to establish its initial content version. A public project ID alone does not grant access; an unclaimed import still needs its original private claim link to establish ownership.

## Claim deadline

Your first upload is playable for one hour without an account. Its JSON result includes `claim_expires_at`, the exact UTC deadline. Give the private claim or approval link to the person and have them sign in and claim the game before that deadline. Claiming keeps the same game link online for free.

At the deadline, the game, claim link and pending agent approvals stop working. The unclaimed game and its uploaded files are then permanently deleted by background cleanup. There is no recovery or late claim. Connecting or retrying does not extend the deadline. Claimed games keep the same project and URL without this expiration.

Keep your local source and build. If an upload expires, publish that local build as a **new game**, using a fresh state file:

```sh
rosebud publish --directory ./dist --state .rosebud/new-project.json \
  --title 'Moon Garden' \
  --description 'Collect five glowing seeds.'
rosebud connect --state .rosebud/new-project.json
```

Use that new state file for subsequent `status` and `update` commands, and claim the new game within its one-hour window. This creates a new project and play link; it cannot restore the deleted one. Choose a different unused state filename if `new-project.json` already exists.

## Work on a game made in Rosebud

To change a game the person built in the Rosebud editor, connect to it, bring its current files into a folder, edit them and update:

```sh
rosebud connect --project <project_id>
# The person opens the approval_url, signs in and approves.
rosebud status
rosebud pull --directory ./game
# Edit the files in ./game.
rosebud update --directory ./game
```

1. Find the project ID in the editor's address: `https://rosebud.ai/edit/<project_id>`.
2. `connect` returns a private `approval_url`. Give it to the person, who signs in and approves access to this one game.
3. `rosebud status` reports `active` once they have, and saves the game's current version.
4. `rosebud pull --directory ./game` writes the game's current files, including edits made in Rosebud, into `./game`. Text files and media both come down; the folder is created if needed.
5. Edit the files. Games made in Rosie include `AGENTS.md` and other notes worth reading before you change anything.
6. `rosebud update --directory ./game` releases your version to the same link. Files Rosebud already has are not uploaded again.

Reading files back needs the game owner's plan to include code download. Without it, `pull` fails with `plan_required` (exit 3) while `publish` and `update` still work: ask the person what they changed in Rosebud before you update, so you don't replace their edits.

## Metadata and context

`publish` and `update` accept `--title` (1–255 characters), `--description` (0–4000 characters) and an optional `--thumbnail` file path. `--name` remains a title alias; conflicting title/name values are rejected. Omitted update metadata is preserved. Changing a title retains the original play URL.

PNG/JPEG thumbnails must be at most 2 MiB and 4096 pixels per side. The server normalizes the image and strips embedded metadata. Supply a gameplay screenshot when available; automatic screenshot capture is not part of this CLI.

Use `--agent-client` to report the actual caller: `codex`, `claude-code`, `gemini-cli`, `cursor`, `other` or `unknown`. The default is `unknown`. Additional optional first-upload context can come from `--context ./context.json`:

```json
{
  "agent_client": "codex",
  "use_case": "game-jam",
  "framework": "vanilla"
}
```

| Field              | Values                                                                              |
| ------------------ | ----------------------------------------------------------------------------------- |
| `agent_client`     | codex, claude-code, gemini-cli, cursor, other, unknown                              |
| `agent_version`    | Reported version, at most 80 characters                                             |
| `model_provider`   | openai, anthropic, google, other, unknown                                           |
| `model`            | Reported model name, at most 100 characters                                         |
| `use_case`         | learning, game-jam, prototype, portfolio, classroom, client-work, commercial, other |
| `framework`        | vanilla, phaser, three, other, unknown                                              |
| `discovery_source` | docs, search, github, recommendation, existing-user, other, unknown                 |

The CLI reports its own version and interface automatically. Other context is explicitly supplied and private to Rosebud. Client/model names are self-reported. Keep prompts, conversations, personal details, local paths and environment variables out of context.

## Updates, conflicts and retries

The CLI remembers the last accepted content version and records an operation ID before sending an update. Rosebud validates the complete bundle and commits the current and published revisions together. A failed release leaves the previous game playable; an identical retry recovers the original result.

Browser edits and other agent releases can make your saved version stale. `rosebud status` shows the remote and saved versions. An update against a stale version is refused with `version_conflict` (exit 3). Its error lists what changed in `changed_paths`:

| `changed_paths` | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| A list of paths | Rosebud changed these files since your last sync (at most 2,000 are listed). |
| `[]`            | Only the game's title, description or cover changed; no file did.            |
| `null`          | Rosebud can't tell which files changed.                                      |
| Missing         | This Rosebud server doesn't report changed files.                            |

`next_action` says what to do, naming up to ten paths. To bring Rosebud's changes in, run `rosebud pull --directory ./game`. Pull takes the files Rosebud changed, removes the ones it deleted and keeps your own edits, including files only you changed. A file changed on both sides is a conflict: pull leaves your copy in place, lists it under `conflicts` and saves Rosebud's copy in a `.remote` folder beside the state file (`.rosebud/project.remote/` for the default state). That folder sits outside your build folder, so `update` never uploads it. On a disk that treats names differing only by letter case as one file (macOS and Windows by default), pull never overwrites a local file with a Rosebud file whose name differs only by case, such as `foo.js` over a `Foo.js` that stays: it reports a conflict with reason `case_conflict`, saves Rosebud's copy and `next_action` says which file to rename. Merge each conflict into your file, keeping both changes. Pull does not move your saved version while conflicts remain, so `update` stays refused until you say which version you merged against:

```sh
rosebud update --directory ./game --expected-version <content_version from pull or status>
```

For a conflict that only touched the title, description or cover, run `rosebud status` and pass its `content_version` the same way.

`rosebud pull --force` settles conflicts the other way: it takes Rosebud's version of each conflicted file, discarding your edit to it. It never touches changes made only on your side; those still go up with your next update. `rosebud update` has no force option and never merges for you.

Active Rosebud generation blocks publication. After an interrupted update, rerun the identical command and input. If the input changed while the outcome was uncertain, check status and reconcile before submitting another release.

When Rosebud is too busy to start a request it answers `busy` (HTTP 503) and changes nothing. The CLI reports it as a rejection (exit 3, outcome `rejected`) with `retry_after_seconds` when Rosebud says how long to wait. Run the same command again after that long (or shortly, when Rosebud gives no time). Because nothing was applied, you may also change your files first, unless an earlier update is still uncertain. A first `publish` refused as busy created nothing and is safe to run again.

First publication has a separate limit: a lost response may leave a created game, and a fresh `publish` may create a duplicate. Requests are not redirected, and a release or publish request is never sent again on its own. Three things are repeated because they are safe: a JSON request that Rosebud throttles waits out `Retry-After` and is sent again (for up to a minute in all), a request for an upload session that is answered `upload_retry` is repeated (up to 20 times), and a media upload to storage that fails in transit is tried up to three times.

Pending connections expire after 30 minutes. Approved access lasts 90 days and can be revoked sooner. It permits files, metadata and ordinary branded publication for one project. It does not permit account-wide access, AI generation, billing changes or paid deployment capabilities.

## Make assets

Generate game art, skyboxes, 3D models, sound effects and music with the person's Rosebud credits. Log in once per machine:

```sh
rosebud login --agent-client codex
```

`login` returns a private `approval_url`. Give it to the person, who signs in and approves this agent once; there is no API key to copy. A pending login expires after 30 minutes. `rosebud whoami` reports whether the login is pending, active, expired or revoked, and the person's credit balance. An approved login lasts until the person disconnects it in Rosebud or you run `rosebud logout`. It works with the person's assets and asset generation, paid from their credits, and `rosebud publish` puts new games in their account. It cannot change billing or manage the account. A publish with a login that still waits for approval fails with `login_pending`; approve it, or run `rosebud logout` to publish with a claim link instead. `login` reports an existing pending or active login instead of replacing it; run `rosebud logout` first to switch accounts.

Choose a model, check the price, then make the asset:

```sh
rosebud assets models --category image
rosebud assets quote --model flux-2-flash --prompt 'Mossy stone tile, top-down' \
  --input asset_type=sprite
rosebud assets create --model flux-2-flash --prompt 'Mossy stone tile, top-down' \
  --input asset_type=sprite --max-credits 300 --out ./dist/assets/stone-tile.png
```

`assets models` lists each model's inputs, price and license; `--category` narrows the list (for example `image`, `skybox`, `model_3d`, `sound_effect` or `music`). `--prompt` fills the model's `prompt` input, `--input name=value` sets any other input it lists (repeat it for several), and `--input-json ./input.json` supplies inputs as one JSON object. Quotes are free and check the inputs.

`create` quotes, refuses a quote above `--max-credits`, starts the job, waits for it (up to `--timeout-ms`, default 600000) and saves the file to `--out`. It never replaces an existing file unless you pass `--force`. With `--no-wait` it returns the job at once; check it with `rosebud assets status <job_id>` and save the file with `rosebud assets download <asset_id> --out <path>`. `rosebud assets list` searches the person's existing assets with `--query` and `--category`.

Credits are charged when a job starts and returned if generation fails. A failed job exits 3 with the reason. The CLI saves each create request, with its quote and idempotency key, before sending it. After an uncertain result (exit 4), including a wait that ran out, rerun the identical command: it resumes the same job instead of paying again. Once a create has finished, the same command makes a new asset. Identical creates run one at a time; to make variations in parallel, vary the prompt or inputs.

The login is stored with the other credentials, separate from project connections, and is bound to the API origin.

## CLI reference

| Command                                                           | Result                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `rosebud publish --directory ./dist`                              | Creates a new game and saves its project handle.                         |
| `rosebud connect`                                                 | Requests owner approval for the saved project.                           |
| `rosebud connect --project <id>`                                  | Requests a new connection to an existing game.                           |
| `rosebud status`                                                  | Reports pending, active, revoked or expired access and content versions. |
| `rosebud pull --directory ./game`                                 | Brings the game's current files, including Rosebud edits, into a folder. |
| `rosebud update --directory ./dist`                               | Releases a changed build to the saved project and play URL.              |
| `rosebud disconnect`                                              | Revokes this agent's connection; the published game stays playable.      |
| `rosebud login`                                                   | Requests the person's approval to make assets with their credits.        |
| `rosebud whoami`                                                  | Reports the login's status and the person's credit balance.              |
| `rosebud logout`                                                  | Revokes the login and removes it from this machine.                      |
| `rosebud assets models`                                           | Lists models with their inputs, prices and licenses.                     |
| `rosebud assets quote --model <id> --prompt <text>`               | Checks inputs and prices an asset without charging.                      |
| `rosebud assets create --model <id> --prompt <text> --out <file>` | Makes an asset, waits for it and saves the file.                         |
| `rosebud assets status <job_id>`                                  | Reports a job's progress and, when done, its asset.                      |
| `rosebud assets list`                                             | Lists the person's assets, newest first.                                 |
| `rosebud assets download <asset_id> --out <file>`                 | Saves an existing asset's file.                                          |
| `rosebud --help`                                                  | Shows commands and options.                                              |
| `rosebud --version`                                               | Prints the installed CLI version.                                        |

Uploads accept exactly one of `--directory` and `--zip`. Common options are `--state` and `--timeout-ms` (default 120000; for `assets create` it bounds the whole wait, default 600000). Each file upload also gets one extra second per 32 KiB on top of `--timeout-ms`, so large media has time to finish. Rosebud is the default destination, and subsequent commands use the saved project connection.

JSON results go to stdout; JSON errors go to stderr. The `error` object includes `message`, `kind`, `code`, `outcome` (`not_sent`, `rejected` or `unknown`) and, when available, HTTP `status`. Rejected uploads also include the server's `filename` and `limit` (always a number) when it reports them, so you know which file to fix. Many errors add a `next_action` saying what to do about them, such as `version_conflict` with its `changed_paths`, `release_upload_limit` or `plan_required`. Asset errors include the `job_id` or `asset_id` once one is known. Asset commands that Rosebud throttles wait the time it asks for and send again, for up to a minute in all; a longer wait fails with code `throttled` and `retry_after_seconds`. While `assets create` waits for its job, a `busy` answer to a status check is waited out the same way. A release or publish is never sent again on its own. Exit codes:

| Exit | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Command succeeded. Check `status` or `whoami` to see whether approval is still pending. |
| 2    | Local input or usage error. Correct the command or build.                               |
| 3    | HTTP rejection. Read its error code before retrying.                                    |
| 4    | The outcome is uncertain. Use the documented recovery path.                             |

The CLI locks the state file during commands. If a process crashes, confirm it stopped before removing the neighboring `.lock` file. Run commands against one state file sequentially.

## Bundle and release limits

Root `index.html` is required. Text files (HTML, JavaScript, CSS, JSON, Markdown notes such as `AGENTS.md`, license notices, and any other UTF-8 file that isn't media) may have any name the Rosebud editor allows: names with no leading dot (no hidden files or folders), not only spaces, none of `/ \ < > : " | ? *` or control characters, and at most 255 characters each; and paths of at most 500 characters. They keep their original paths and contents, so do not discard license notices. `.svg` and `.gltf` files outside `assets/` are text too.

Operating-system junk (`.DS_Store`, `Thumbs.db` and `desktop.ini`, in any case) is skipped: it is never uploaded and never an error. Other hidden files, credentials, dependency folders, links, unsafe paths and unsupported formats are rejected. Credentials and dependencies are the names `credentials`, `secrets`, `credentials.json`, `service-account.json`, `service_account.json` and `node_modules`, any name containing `firebase-adminsdk`, and any name ending in `.env`, compared in any case and ignoring surrounding spaces. Rosebud also refuses a file that holds a private key.

Binary media goes under `assets/` with a canonical lowercase name (the CLI says which rename is needed before it sends anything). The media types are PNG/JPEG/WebP/SVG images, WAV/MP3/OGG audio, WOFF/WOFF2/TTF/OTF fonts, WASM, GLB/glTF models and binary model buffers (`.bin`). A file Rosebud already holds keeps its type: media it serves is sent as media whatever its name or type, and a file it holds as text, such as an `assets/icon.svg` that Rosie wrote, stays text. The CLI learns which is which from your last `publish`, `update` or `pull`.

Media goes to Rosebud file by file, not inside the ZIP, so a game is no longer limited to 10 MiB of media:

- Each file is at most 19 MiB.
- A game has at most 2,000 files and 1 GiB in all.
- Text files travel in one ZIP of at most 10 MiB compressed, 50 MiB expanded and 500 files.
- Rosebud also limits how much new media one update adds at once, currently 128 MiB. When an update goes over it, the error is `release_upload_limit`, and it carries the exact `limit` in bytes: update with part of the new media first, then again with the rest.
- Files Rosebud already has, with the same path, size and MD5, are not uploaded again.

While Rosebud checks a game's existing files it may answer a request for an upload session with `upload_retry`. The CLI asks again by itself, after the `Retry-After` it is given (one second without one, at most 10), up to 20 times; after that it stops with `next_action` to run the same command again. A Rosebud server without file-by-file uploads still takes a game as one ZIP, up to 10 MiB compressed. `--zip` uploads an archive you made as it is, within the same ZIP limits.

Build locally before publishing, and keep developer tools and credentials outside the game build.

Successful upload confirms import/publication, not gameplay. Open the returned play URL and test startup, controls, assets, audio and a full round. Published game files are public; keep secrets out of the bundle.

## Getting help

Report bugs and ask questions in [GitHub issues](https://github.com/rosebudai/rosebud-cli/issues). For security issues, follow [SECURITY.md](SECURITY.md) instead. Never paste claim links, approval links or credentials into an issue.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license does not grant rights to the Rosebud name or logo.
