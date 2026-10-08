import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { posix, win32 } from "node:path";
import { Rosebud, RosebudError } from "../dist/index.js";
import { exposedToOtherUsers, outsideBuild } from "../dist/state.js";

const success = {
  project_id: "f6879913-2dda-484b-b1dc-3abc60cac45a",
  play_url: "https://example.invalid/p/game",
  claim_url: "https://example.invalid/claim#test-only-secret",
  claim_expires_at: "2030-01-08T12:00:00Z",
  content_version: "a".repeat(64),
  future_field: { kept: true },
};

async function directory(t, files = { "index.html": "<button>Play</button>" }) {
  const root = await mkdtemp(join(tmpdir(), "rosebud-sdk-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

async function api(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    requests.push({
      method: req.method,
      url: req.url,
      bytes,
      headers: req.headers,
    });
    try {
      await handler(req, res, bytes);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

function json(res, body, status = 201) {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

async function cli(args, env = {}) {
  const work = await mkdtemp(join(tmpdir(), "rosebud-cli-test-"));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args],
    {
      cwd: work,
      env: {
        ...process.env,
        ROSEBUD_API_BASE: "",
        ROSEBUD_CREDENTIALS_DIR: join(work, "credentials"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  await rm(work, { recursive: true, force: true });
  return { code, stdout, stderr };
}

test("directory publishing preserves paths/bytes, supplies multipart name and returns the actual result", async (t) => {
  const contents = {
    "index.html": '<script src="assets/main.js"></script>',
    "assets/main.js": 'console.log("play")',
    "assets/settings.json": '{"score": 5}',
    "assets/DM-SANS-LICENSE.txt":
      "Copyright © fixture authors\r\nPermission notice.\r\n",
    LICENSE: "Permission is hereby granted.\n",
    NOTICE: "Third-party notices.\n",
    "vendor/LICENSE.TXT": "Original uppercase notice.\n",
    "assets/pixel.png": Buffer.from([137, 80, 78, 71]),
    ...Object.fromEntries(
      [
        "webp",
        "svg",
        "ogg",
        "oga",
        "woff",
        "woff2",
        "ttf",
        "otf",
        "wasm",
        "glb",
        "gltf",
        "bin",
      ].map((extension) => [
        `assets/game.${extension}`,
        Buffer.from(`preserved ${extension} bytes`),
      ]),
    ),
  };
  const root = await directory(t, contents);
  const archives = [];
  const remote = await api(t, async (req, res, bytes) => {
    const form = await new Response(bytes, {
      headers: { "content-type": req.headers["content-type"] },
    }).formData();
    assert.equal(form.get("name"), "Signal Garden");
    assert.equal(form.get("bundle").type, "application/zip");
    const archive = new Uint8Array(await form.get("bundle").arrayBuffer());
    archives.push(archive);
    const files = unzipSync(archive);
    assert.deepEqual(
      Object.keys(files).sort(),
      [...Object.keys(contents), "assets/", "vendor/"].sort(),
    );
    for (const [path, content] of Object.entries(contents))
      assert.deepEqual(Buffer.from(files[path]), Buffer.from(content));
    json(res, success);
  });
  const client = new Rosebud({ apiBaseUrl: remote.base });
  assert.deepEqual(
    await client.publish({ directory: root, name: "Signal Garden" }),
    success,
  );
  assert.deepEqual(
    await client.publish({ directory: root, name: "Signal Garden" }),
    success,
  );
  assert.deepEqual(archives[0], archives[1]);
  assert.equal(remote.requests[0].url, "/api/developer/projects/import/");
  assert.equal(remote.requests[0].method, "POST");
});

test("existing ZIP bytes go unchanged to server validation", async (t) => {
  const root = await directory(t, {
    "existing.zip": Buffer.from("server validates these bytes"),
  });
  const remote = await api(t, async (req, res, bytes) => {
    const form = await new Response(bytes, {
      headers: { "content-type": req.headers["content-type"] },
    }).formData();
    assert.equal(form.get("name"), null);
    assert.equal(
      Buffer.from(await form.get("bundle").arrayBuffer()).toString(),
      "server validates these bytes",
    );
    json(res, success);
  });
  await new Rosebud({ apiBaseUrl: remote.base }).publish({
    zip: join(root, "existing.zip"),
  });
});

test("input errors explain the correction before any HTTP request", async (t) => {
  const remote = await api(t, (_req, res) => json(res, success));
  const root = await directory(t, { "main.js": "play()" });
  const client = new Rosebud({ apiBaseUrl: remote.base });
  await assert.rejects(
    client.publish({ directory: root }),
    (e) =>
      e instanceof RosebudError &&
      e.code === "missing_index" &&
      e.outcome === "not_sent",
  );
  await writeFile(join(root, "index.html"), "<p>Fixed</p>");
  assert.deepEqual(await client.publish({ directory: root }), success);
  assert.equal(remote.requests.length, 1);
});

test("packaging refuses unsupported files, hidden files and links instead of dropping them", async (t) => {
  const remote = await api(t, (_req, res) => json(res, success));
  const client = new Rosebud({ apiBaseUrl: remote.base });
  for (const [name, code] of [
    ["source.ts", "unsupported_file"],
    [".env", "unsafe_path"],
    ["credentials.json", "excluded_file"],
  ]) {
    const root = await directory(t, {
      "index.html": "<p>Game</p>",
      [name]: "private",
    });
    await assert.rejects(
      client.publish({ directory: root }),
      (e) => e.code === code && e.outcome === "not_sent",
    );
  }
  const root = await directory(t);
  await symlink(join(root, "index.html"), join(root, "linked.html"));
  await assert.rejects(
    client.publish({ directory: root }),
    (e) => e.code === "unsupported_input",
  );
  assert.equal(remote.requests.length, 0);
});

test("archive and entry bounds fail before upload", async (t) => {
  const root = await directory(t);
  const file = await open(join(root, "large.zip"), "w");
  await file.truncate(10 * 1024 * 1024 + 1);
  await file.close();
  const client = new Rosebud({ apiBaseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    client.publish({ zip: join(root, "large.zip") }),
    (e) => e.code === "size_limit",
  );
  await rm(join(root, "large.zip"));
  await Promise.all(
    Array.from({ length: 500 }, (_, n) => writeFile(join(root, `${n}.js`), "")),
  );
  await assert.rejects(
    client.publish({ directory: root }),
    (e) => e.code === "entry_limit",
  );
});

test("structured API errors retain status, server code and exact details", async (t) => {
  const body = {
    error: {
      code: "invalid_media",
      message: "Supply a valid PNG.",
      filename: "assets/a.png",
      limit: "1024",
    },
  };
  const remote = await api(t, (_req, res) => json(res, body, 400));
  const root = await directory(t);
  await assert.rejects(
    new Rosebud({ apiBaseUrl: remote.base }).publish({ directory: root }),
    (e) => {
      assert.ok(e instanceof RosebudError);
      assert.equal(e.kind, "api");
      assert.equal(e.code, "invalid_media");
      assert.equal(e.status, 400);
      assert.equal(e.outcome, "rejected");
      assert.deepEqual(e.body, body);
      return true;
    },
  );
  assert.equal(remote.requests.length, 1);
});

test("server failures remain uncertain and are never retried", async (t) => {
  const root = await directory(t);
  const remote = await api(t, (_req, res) =>
    json(
      res,
      { error: { code: "import_failed", message: "Unavailable" } },
      503,
    ),
  );
  await assert.rejects(
    new Rosebud({ apiBaseUrl: remote.base }).publish({ directory: root }),
    (e) => e.kind === "api" && e.status === 503 && e.outcome === "unknown",
  );
  assert.equal(remote.requests.length, 1);
});

test("redirects cannot resend the upload to another endpoint", async (t) => {
  const root = await directory(t);
  const target = await api(t, (_req, res) => json(res, success));
  const source = await api(t, (_req, res) =>
    res.writeHead(307, { location: target.base }).end(),
  );
  await assert.rejects(
    new Rosebud({ apiBaseUrl: source.base }).publish({ directory: root }),
    (e) => e.status === 307 && e.outcome === "unknown",
  );
  assert.equal(source.requests.length, 1);
  assert.equal(target.requests.length, 0);
});

test("interrupted upload and response timeout report uncertainty without retries", async (t) => {
  const root = await directory(t);
  for (const behavior of ["disconnect", "timeout"]) {
    const remote = await api(t, (req, res) => {
      if (behavior === "disconnect") req.socket.destroy();
      else
        res.writeHead(201, { "content-type": "application/json" }).write("{");
    });
    await assert.rejects(
      new Rosebud({ apiBaseUrl: remote.base, timeoutMs: 300 }).publish({
        directory: root,
      }),
      (e) => e.kind === "transport" && e.outcome === "unknown",
    );
    assert.equal(remote.requests.length, 1);
  }
});

test("unexpected successful response never copies a claim secret to diagnostics", async (t) => {
  const root = await directory(t);
  const remote = await api(t, (_req, res) =>
    json(res, { claim_url: success.claim_url }),
  );
  await assert.rejects(
    new Rosebud({ apiBaseUrl: remote.base }).publish({ directory: root }),
    (e) => {
      assert.equal(e.kind, "response");
      assert.equal(e.outcome, "unknown");
      assert.equal(e.body, undefined);
      assert.ok(!JSON.stringify(e).includes("test-only-secret"));
      return true;
    },
  );
});

test("cancellation before sending has a known not-sent outcome", async (t) => {
  const root = await directory(t);
  const remote = await api(t, (_req, res) => json(res, success));
  await assert.rejects(
    new Rosebud({ apiBaseUrl: remote.base }).publish({
      directory: root,
      signal: AbortSignal.abort(),
    }),
    (e) => e.code === "aborted" && e.outcome === "not_sent",
  );
  assert.equal(remote.requests.length, 0);
});

test("CLI uses the library contract and reserves stdout for the result", async (t) => {
  const root = await directory(t);
  const remote = await api(t, async (req, res, bytes) => {
    const form = await new Response(bytes, {
      headers: { "content-type": req.headers["content-type"] },
    }).formData();
    assert.equal(
      strFromU8(
        unzipSync(new Uint8Array(await form.get("bundle").arrayBuffer()))[
          "index.html"
        ],
      ),
      "<button>Play</button>",
    );
    json(res, success);
  });
  const result = await cli(["publish", "--directory", root], {
    ROSEBUD_API_BASE: remote.base,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  for (const key of Object.keys(success))
    assert.deepEqual(output[key], success[key]);
  assert.match(output.next_action, /connect/);
  assert.ok(output.next_action.includes(success.claim_expires_at));
});

test("CLI exposes usage, rejection and uncertain errors with documented exits", async (t) => {
  const root = await directory(t);
  const usage = await cli([
    "publish",
    "--directory",
    root,
    "--zip",
    "game.zip",
  ]);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, "");
  assert.equal(JSON.parse(usage.stderr).error.outcome, "not_sent");
  const remote = await api(t, (_req, res) =>
    json(
      res,
      { error: { code: "missing_index", message: "Put index.html at root." } },
      400,
    ),
  );
  const rejected = await cli([
    "publish",
    "--directory",
    root,
    "--api-base",
    remote.base,
  ]);
  assert.equal(rejected.code, 3);
  assert.equal(rejected.stdout, "");
  assert.equal(JSON.parse(rejected.stderr).error.code, "missing_index");
  const uncertain = await cli([
    "publish",
    "--directory",
    root,
    "--api-base",
    "http://127.0.0.1:1",
  ]);
  assert.equal(uncertain.code, 4);
  assert.equal(uncertain.stdout, "");
  assert.equal(JSON.parse(uncertain.stderr).error.outcome, "unknown");
});

test("CLI help/version do not require input or API access", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--directory/);
  const version = await cli(["--version"]);
  assert.equal(version.code, 0);
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(version.stdout.trim(), metadata.version);
});

test("directory preflight explains media path corrections before sending", async (t) => {
  const remote = await api(t, (_req, res) => json(res, success));
  const client = new Rosebud({ apiBaseUrl: remote.base });
  for (const [path, code, correction] of [
    ["logo.png", "media_path", "assets/"],
    ["assets/logo-BdF3x9.png", "noncanonical_path", "assets/logo-bdf3x9.png"],
    [
      "assets/Models/ship.v2.glb",
      "noncanonical_path",
      "assets/models/ship-v2.glb",
    ],
    ["assets/_ship--final_.png", "noncanonical_path", "assets/ship-final.png"],
  ]) {
    const root = await directory(t, {
      "index.html": "Play",
      [path]: "fixture",
    });
    await assert.rejects(client.publish({ directory: root }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.outcome, "not_sent");
      assert.ok(error.message.includes(correction));
      return true;
    });
  }
  assert.equal(remote.requests.length, 0);
  const corrected = await directory(t, {
    "index.html": "Play",
    "assets/sub_dir/player_ship.png": "fixture",
  });
  assert.deepEqual(await client.publish({ directory: corrected }), success);
  assert.equal(remote.requests.length, 1);
});

test("CLI uncertain HTTP and invalid responses use exit 4 without retrying", async (t) => {
  const root = await directory(t);
  for (const status of [500, 502, 200]) {
    const remote = await api(t, (_req, res) => {
      if (status === 500)
        json(
          res,
          { error: { code: "internal_error", message: "Fixture failure" } },
          status,
        );
      else
        res
          .writeHead(status, { "content-type": "text/html" })
          .end("<html>Unexpected response</html>");
    });
    const result = await cli([
      "publish",
      "--directory",
      root,
      "--api-base",
      remote.base,
    ]);
    assert.equal(result.code, 4, `HTTP ${status}`);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.outcome, "unknown");
    assert.equal(remote.requests.length, 1);
  }
});

test("the state file can sit beside the build folder on Windows and POSIX", () => {
  const insideBuild = (error) => error.code === "state_in_build";
  outsideBuild("C:\\game\\.rosebud\\project.json", "C:\\game\\dist", win32);
  outsideBuild("D:\\state\\project.json", "C:\\game\\dist", win32);
  assert.throws(
    () =>
      outsideBuild(
        "C:\\game\\dist\\.rosebud\\project.json",
        "C:\\game\\dist",
        win32,
      ),
    insideBuild,
  );
  outsideBuild("/game/.rosebud/project.json", "/game/dist", posix);
  assert.throws(
    () => outsideBuild("/game/dist/project.json", "/game/dist", posix),
    insideBuild,
  );
});

test("rejected uploads report the server's filename and limit but nothing else from the body", async (t) => {
  const root = await directory(t);
  const remote = await api(t, (_req, res) =>
    json(
      res,
      {
        error: {
          code: "invalid_media",
          message: "Supply a valid game asset matching its extension.",
          filename: "assets/corrupt.png",
          limit: 10000,
          internal: "not for output",
        },
      },
      400,
    ),
  );
  const result = await cli([
    "publish",
    "--directory",
    root,
    "--api-base",
    remote.base,
  ]);
  assert.equal(result.code, 3);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "invalid_media");
  assert.equal(error.filename, "assets/corrupt.png");
  assert.equal(error.limit, 10000);
  assert.equal(error.internal, undefined);
});

test("credentials only travel over HTTPS, except to a local server", () => {
  assert.throws(
    () => new Rosebud({ apiBaseUrl: "http://api.example.com" }),
    (error) => error instanceof RosebudError && error.code === "api_base",
  );
  for (const origin of [
    "https://api.rosebud.ai",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
  ])
    assert.equal(new Rosebud({ apiBaseUrl: origin }).apiBaseUrl, origin);
});

test("private files are only judged by permission bits where the platform has them", () => {
  assert.equal(exposedToOtherUsers(0o100600, "linux"), false);
  assert.equal(exposedToOtherUsers(0o100644, "linux"), true);
  assert.equal(exposedToOtherUsers(0o100660, "darwin"), true);
  // Windows always reports 0o666; rejecting it broke every command after publish.
  assert.equal(exposedToOtherUsers(0o100666, "win32"), false);
});

test("publishing a project root says how to publish a game without a build step", async (t) => {
  const remote = await api(t, (_req, res) => json(res, success));
  const client = new Rosebud({ apiBaseUrl: remote.base });
  const root = await directory(t, {
    "index.html": "<p>Game</p>",
    ".gitignore": "node_modules",
  });
  await assert.rejects(
    client.publish({ directory: root }),
    (e) =>
      e.code === "unsafe_path" &&
      e.message.includes(".gitignore") &&
      e.message.includes("./dist"),
  );
  assert.throws(
    () => outsideBuild("/game/.rosebud/project.json", "/game", posix),
    (e) => e.code === "state_in_build" && e.message.includes("./dist"),
  );
  assert.equal(remote.requests.length, 0);
});
