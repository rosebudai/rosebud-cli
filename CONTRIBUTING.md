# Contributing

## Develop

```sh
npm ci
npm run check
npm test
```

`npm test` builds the CLI and runs the Node test suite. Tests replace `fetch` and never contact a real Rosebud server.

## Point the CLI at another server

The CLI publishes to `https://api.rosebud.ai` unless you override it. These overrides are for Rosebud maintainers testing other environments, so they're left out of `--help` and the public README:

- `--api-base <origin>` on any command
- the `ROSEBUD_API_BASE` environment variable

Precedence is the flag, then a nonempty environment variable, then the origin saved with the project, then the default. The origin must be HTTPS; plain HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]`.

A saved project stays tied to the origin it was published to, and the CLI refuses to send it anywhere else. Use a separate `--state` file per environment, for example:

```sh
ROSEBUD_API_BASE=http://localhost:8000 \
  rosebud publish --directory ./dist --state .rosebud/local.json --title 'Test game'
```

## Release

1. In a pull request, update `version` in `package.json` and `package-lock.json` and add a `CHANGELOG.md` entry. CI must pass on Linux and Windows.
2. After merging, tag the merge commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Stage npm release** workflow checks that the tag matches `package.json`, runs the checks and tests, and stages the release with provenance. It authenticates through npm trusted publishing, so the repository stores no npm token, and that publisher can only stage. Versions with a hyphen (for example `0.2.0-rc.1`) go to the `next` dist-tag instead of `latest`.
4. A maintainer with 2FA approves the release. Run `npm stage list @rosebudai/cli`, check with `npm stage view <stage-id>` that the shasum matches the one in the workflow log, then run `npm stage approve <stage-id>`, or approve it on npmjs.com. Until then nobody can install the new version. To drop a bad release, run `npm stage reject <stage-id>`.
