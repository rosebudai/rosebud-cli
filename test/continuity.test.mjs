import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Rosebud } from "../dist/index.js";

const project = "877d5ce8-9bca-4c9d-831b-e2424a2ff75d";
const connection = "210406eb-fb72-4811-8de0-339ace4968dc";
const token = "T".repeat(43),
  secret = "S".repeat(43);
const play = "https://example.invalid/p/same-game";
function json(res, body, status = 200) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

async function server(t, handler) {
  const app = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await handler(req, res, Buffer.concat(chunks));
    } catch (error) {
      json(res, { error: { code: "fixture", message: String(error) } }, 500);
    }
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  });
  return `http://127.0.0.1:${app.address().port}`;
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "rosebud-continuity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.html"), "Game one");
  return root;
}
async function cli(root, args, execArgs = []) {
  const child = spawn(
    process.execPath,
    [
      ...execArgs,
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ROSEBUD_API_BASE: "",
        ROSEBUD_CREDENTIALS_DIR: join(root, "credentials"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const [code] = await once(child, "close");
  return {
    code,
    stdout,
    stderr,
    data: stdout ? JSON.parse(stdout) : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}

test("CLI publishes to Rosebud without configuration and saves its destination", async (t) => {
  const root = await workspace(t);
  const origin = "https://api.rosebud.ai";
  const transport = join(root, "transport.mjs");
  // Intercept the child process's only network boundary; this must never upload to production.
  await writeFile(
    transport,
    `
    import assert from "node:assert/strict";
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), ${JSON.stringify(`${origin}/api/developer/projects/import/`)});
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("title"), "My game");
      return Response.json(${JSON.stringify({
        project_id: project,
        play_url: play,
        claim_url: `https://example.invalid/claim#${secret}`,
        claim_expires_at: "2030-01-08T12:00:00Z",
        content_version: "a".repeat(64),
      })}, { status: 201 });
    };
  `,
  );
  const published = await cli(
    root,
    ["publish", "--directory", "dist", "--title", "My game"],
    ["--import", pathToFileURL(transport).href],
  );
  assert.equal(published.code, 0, published.stderr);
  assert.equal(published.data.project_id, project);
  const handle = JSON.parse(
    await readFile(join(root, ".rosebud/project.json"), "utf8"),
  );
  assert.equal(handle.api_base_url, origin);
  assert.equal(handle.project_id, project);
});

test("library sends metadata and private adoption context without filesystem state", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "cover.png"), "image bytes validated by the API");
  const origin = await server(t, async (req, res, bytes) => {
    const form = await new Response(bytes, {
      headers: { "Content-Type": req.headers["content-type"] },
    }).formData();
    assert.equal(form.get("title"), "Moon Garden");
    assert.equal(form.get("description"), "Collect seeds");
    assert.equal(
      await form.get("thumbnail").text(),
      "image bytes validated by the API",
    );
    assert.deepEqual(JSON.parse(form.get("context")), {
      agent_client: "codex",
      use_case: "game-jam",
    });
    json(
      res,
      {
        project_id: project,
        play_url: play,
        claim_url: `https://example.invalid/claim#${secret}`,
        claim_expires_at: "2030-01-08T12:00:00Z",
        content_version: "a".repeat(64),
      },
      201,
    );
  });
  await new Rosebud({ apiBaseUrl: origin }).publish({
    directory: join(root, "dist"),
    title: "Moon Garden",
    description: "Collect seeds",
    thumbnail: join(root, "cover.png"),
    context: { agent_client: "codex", use_case: "game-jam" },
  });
  assert.deepEqual((await readdir(root)).sort(), ["cover.png", "dist"]);
});

test("independent CLI sessions retain one project, require approval, recover lost updates and preserve conflict boundaries", async (t) => {
  const root = await workspace(t);
  let access = "pending",
    currentVersion = "a".repeat(64),
    imported = 0,
    writes = 0,
    loseResponse = true;
  let rateLimitRetry = true;
  const operations = new Map();
  const requests = [];
  const origin = await server(t, async (req, res, bytes) => {
    requests.push(req.url);
    if (req.url.endsWith("/import/")) {
      imported++;
      json(
        res,
        {
          project_id: project,
          play_url: play,
          claim_url: `https://example.invalid/claim#${secret}`,
          claim_expires_at: "2030-01-08T12:00:00Z",
          content_version: currentVersion,
        },
        201,
      );
      return;
    }
    if (req.url.endsWith("/connect/")) {
      assert.equal(JSON.parse(bytes).claim_secret, secret);
      json(
        res,
        {
          project_id: project,
          connection_id: connection,
          agent_token: token,
          approval_url: `https://example.invalid/connect#${secret}`,
          status: "pending",
          expires_at: "2030-01-01T00:00:00Z",
        },
        201,
      );
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url.endsWith("/connection/")) {
      if (req.method === "DELETE") {
        access = "revoked";
        res.writeHead(204).end();
        return;
      }
      json(res, {
        project_id: project,
        connection_id: connection,
        status: access,
        expires_at: "2030-01-01T00:00:00Z",
        ...(access === "active"
          ? { content_version: currentVersion, play_url: play }
          : {}),
      });
      return;
    }
    assert.ok(req.url.endsWith("/releases/"));
    if (access !== "active") {
      json(
        res,
        { error: { code: "connection_pending", message: "Approve access." } },
        403,
      );
      return;
    }
    const form = await new Response(bytes, {
      headers: { "Content-Type": req.headers["content-type"] },
    }).formData();
    const operation = form.get("operation_id");
    if (operations.has(operation)) {
      if (rateLimitRetry) {
        rateLimitRetry = false;
        json(res, { error: { code: "throttled", message: "Try later." } }, 429);
        return;
      }
      json(res, operations.get(operation));
      return;
    }
    if (form.get("expected_version") !== currentVersion) {
      json(
        res,
        { error: { code: "version_conflict", message: "Reconcile changes." } },
        409,
      );
      return;
    }
    writes++;
    currentVersion = String(writes).repeat(64);
    const result = {
      project_id: project,
      play_url: play,
      content_version: currentVersion,
      operation_id: operation,
    };
    operations.set(operation, result);
    if (loseResponse) {
      loseResponse = false;
      req.socket.destroy();
      return;
    }
    json(res, result);
  });
  const published = await cli(root, [
    "publish",
    "--directory",
    "dist",
    "--api-base",
    origin,
    "--title",
    "My game",
  ]);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(imported, 1);
  assert.equal(
    (await cli(root, ["publish", "--directory", "dist"])).error.code,
    "project_exists",
  );
  const connected = await cli(root, ["connect", "--agent-client", "codex"]);
  assert.equal(connected.code, 0, connected.stderr);
  assert.equal(connected.data.status, "pending");
  assert.ok(!connected.stdout.includes(token));
  assert.equal(
    (await cli(root, ["update", "--directory", "dist"])).error.code,
    "connection_pending",
  );
  access = "active";
  assert.equal((await cli(root, ["status"])).data.status, "active");
  // A build clean/rebuild cannot delete the saved binding or credentials.
  await rm(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.html"), "Game two");
  const lost = await cli(root, ["update", "--directory", "dist"]);
  assert.equal(lost.code, 4, lost.stderr);
  assert.equal(writes, 1);
  await writeFile(
    join(root, "dist/index.html"),
    "Changed while outcome uncertain",
  );
  assert.equal(
    (await cli(root, ["update", "--directory", "dist"])).error.code,
    "pending_operation",
  );
  await writeFile(join(root, "dist/index.html"), "Game two");
  assert.equal(
    (await cli(root, ["update", "--directory", "dist"])).error.code,
    "throttled",
  );
  const recovered = await cli(root, ["update", "--directory", "dist"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.data.play_url, play);
  assert.equal(writes, 1);
  currentVersion = "b".repeat(64); // An intervening browser edit.
  const observed = await cli(root, ["status"]);
  assert.equal(observed.data.content_version, currentVersion);
  assert.notEqual(observed.data.saved_content_version, currentVersion);
  assert.equal(
    (await cli(root, ["update", "--directory", "dist"])).error.code,
    "version_conflict",
  );
  assert.equal(
    (
      await cli(root, [
        "update",
        "--directory",
        "dist",
        "--expected-version",
        currentVersion,
      ])
    ).code,
    0,
  );
  const before = requests.length;
  assert.equal(
    (await cli(root, ["status", "--api-base", "https://different.invalid"]))
      .error.code,
    "origin_mismatch",
  );
  assert.equal(requests.length, before);
  const handle = JSON.parse(
    await readFile(join(root, ".rosebud/project.json"), "utf8"),
  );
  assert.equal(handle.project_id, project);
  assert.ok(!JSON.stringify(handle).includes(token));
  // Windows has no POSIX permission bits to check.
  if (process.platform !== "win32")
    for (const name of await readdir(join(root, "credentials")))
      assert.equal(
        (await stat(join(root, "credentials", name))).mode & 0o777,
        0o600,
      );
  assert.equal((await cli(root, ["disconnect"])).data.status, "revoked");
  assert.equal(imported, 1);
  assert.equal(writes, 2);
});
