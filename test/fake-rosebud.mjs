import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";

export const PROJECT = "877d5ce8-9bca-4c9d-831b-e2424a2ff75d";
export const AGENT = "T".repeat(43);
export const LOGIN = `rbk_${"L".repeat(43)}`;
const MEDIA =
  /\.(png|jpe?g|wav|mp3|webp|svg|ogg|oga|woff2?|ttf|otf|wasm|glb|gltf|bin|mp4|gif)$/;
export const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

function reply(res, status, body) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(body === undefined ? "" : JSON.stringify(body));
}
const fail = (res, status, code, extra = {}) =>
  reply(res, status, { error: { code, message: `fake: ${code}`, ...extra } });

/**
 * An in-memory Rosebud holding one game, with enough of the agent API for CLI tests.
 * `game.text` and `game.media` are the current files; `edit()` changes them the way
 * Rosie would, without recording a manifest.
 */
export async function fakeRosebud(t, options = {}) {
  const game = {
    sync: options.sync ?? true,
    pro: options.pro ?? true,
    access: options.access ?? "active",
    text: new Map(),
    media: new Map(),
    version: "0".repeat(64),
    manifests: new Map(), // version → Map(path → md5)
    sessions: new Map(),
    operations: new Map(),
    releases: 0,
    puts: [],
    requests: [],
    failPuts: options.failPuts ?? 0,
    refusePuts: options.refusePuts ?? false,
    putDelayMs: options.putDelayMs ?? 0,
    loseNextRelease: false,
    hideMd5: options.hideMd5 ?? false, // files() reports no MD5, as for old uploads
    failMedia: options.failMedia ?? 0, // media downloads answered 503, one each
    damageMedia: options.damageMedia ?? false, // media downloads lose their last byte
    uploadRetries: options.uploadRetries ?? 0, // upload sessions answered 409 upload_retry, one each
    uploadRetryAfter: options.uploadRetryAfter, // their Retry-After seconds, when given
    // The `remaining` each upload_retry answer carries, used verbatim, one per answer and before
    // `uploadRetries` is counted; an old Rosebud sends none.
    uploadRemaining: [...(options.uploadRemaining ?? [])],
    // Text names are stored in NFC, as Rosebud's file rules say, whatever form was uploaded.
    nfc: options.nfc ?? false,
    putHeaders: options.putHeaders ?? {}, // more headers each signed upload must carry
    // Canned answers for API routes: { path: "/releases/", status, error, headers, times }.
    // Each is used up `times` (default 1) matching requests, in order, before the real route runs.
    inject: [],
  };
  const manifest = () =>
    new Map([
      ...[...game.text].map(([path, text]) => [path, md5(Buffer.from(text))]),
      ...[...game.media].map(([path, bytes]) => [path, md5(bytes)]),
    ]);
  const bump = () => {
    game.version = createHash("sha256")
      .update(JSON.stringify([...manifest()].sort()))
      .digest("hex");
  };
  const record = () => game.manifests.set(game.version, manifest());
  game.edit = ({ text = {}, media = {}, remove = [] }) => {
    for (const [path, content] of Object.entries(text))
      game.text.set(path, content);
    for (const [path, bytes] of Object.entries(media))
      game.media.set(path, Buffer.from(bytes));
    for (const path of remove)
      game.text.delete(path) || game.media.delete(path);
    bump();
  };

  async function form(req, bytes) {
    return new Response(bytes, {
      headers: { "Content-Type": req.headers["content-type"] },
    }).formData();
  }
  // Rosebud's rule for a ZIP entry: .svg and .gltf are text outside assets/, and inside it
  // they stay text on an update when Rosebud already holds them as text.
  const zippedAsMedia = (path) =>
    MEDIA.test(path) &&
    (!/\.(svg|gltf)$/.test(path) ||
      (path.startsWith("assets/") && !game.text.has(path)));
  // A release is a snapshot: the ZIP's text plus every path the session declared.
  async function snapshot(fields, res) {
    const zip = unzipSync(
      new Uint8Array(await fields.get("bundle").arrayBuffer()),
    );
    const text = new Map(),
      media = new Map();
    for (const [path, bytes] of Object.entries(zip)) {
      if (path.endsWith("/")) continue;
      if (zippedAsMedia(path)) media.set(path, Buffer.from(bytes));
      else text.set(game.nfc ? path.normalize("NFC") : path, strFromU8(bytes));
    }
    if (fields.get("upload_id")) {
      const session = game.sessions.get(fields.get("upload_id"));
      if (!session || session.token !== fields.get("upload_token"))
        return fail(res, 404, "invalid_upload");
      for (const [path, entry] of session.entries) {
        if (entry.linked) media.set(path, game.media.get(path));
        else if (!entry.bytes)
          return fail(res, 400, "upload_missing", { filename: path });
        else media.set(path, entry.bytes);
      }
    }
    return { text, media };
  }

  const app = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const url = new URL(req.url, "http://fake");
    game.requests.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
    });
    const route = url.pathname;
    try {
      const canned = game.inject.find(
        (item) => route.endsWith(item.path) && (item.times ?? 1) > 0,
      );
      if (canned) {
        canned.times = (canned.times ?? 1) - 1;
        res
          .writeHead(canned.status, {
            "Content-Type": "application/json",
            ...canned.headers,
          })
          .end(
            JSON.stringify({
              error: { message: `fake: ${canned.error.code}`, ...canned.error },
            }),
          );
        return;
      }
      // Media downloads carry no credential, like signed storage URLs.
      if (route.startsWith("/media/")) {
        const data = game.media.get(
          decodeURIComponent(route.slice("/media/".length)),
        );
        if (data && game.failMedia > 0) {
          game.failMedia -= 1;
          return res.writeHead(503).end();
        }
        const sent = data && game.damageMedia ? data.subarray(0, -1) : data;
        return res.writeHead(data ? 200 : 404).end(sent ?? "");
      }
      if (route === "/api/developer/uploads/" && req.method === "POST") {
        if (!game.sync) return fail(res, 503, "sync_unavailable");
        if (game.uploadRemaining.length > 0 || game.uploadRetries > 0) {
          const progress = game.uploadRemaining.length > 0;
          const remaining = progress ? game.uploadRemaining.shift() : undefined;
          if (!progress) game.uploadRetries -= 1;
          return res
            .writeHead(409, {
              "Content-Type": "application/json",
              ...(game.uploadRetryAfter === undefined
                ? {}
                : { "Retry-After": String(game.uploadRetryAfter) }),
            })
            .end(
              JSON.stringify({
                error: {
                  code: "upload_retry",
                  message: "Still checking this game's files.",
                  ...(progress ? { remaining } : {}),
                },
              }),
            );
        }
        const body = JSON.parse(bytes);
        if (body.project_id && req.headers.authorization !== `Bearer ${AGENT}`)
          return fail(res, 401, "invalid_connection");
        const id = randomUUID(),
          token = "U".repeat(43);
        const entries = new Map(),
          uploads = [],
          linked = [];
        body.files.forEach((file, index) => {
          const current = game.media.get(file.path);
          const isLinked =
            body.project_id &&
            current &&
            md5(current) === file.md5 &&
            current.length === file.size;
          entries.set(file.path, { ...file, linked: Boolean(isLinked) });
          if (isLinked) linked.push(file.path);
          else
            uploads.push({
              path: file.path,
              url: `${base}/storage/${id}/${index}`,
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-MD5": Buffer.from(file.md5, "hex").toString("base64"),
                "x-goog-content-length-range": `${file.size},${file.size}`,
                ...game.putHeaders,
              },
            });
        });
        game.sessions.set(id, { token, entries, project: body.project_id });
        return reply(res, 201, {
          upload_id: id,
          upload_token: token,
          expires_at: "2030-01-01T00:00:00Z",
          linked,
          uploads,
        });
      }
      if (route.startsWith("/storage/") && req.method === "PUT") {
        const [, , id, index] = route.split("/");
        const session = game.sessions.get(id);
        const entry = [...session.entries.values()][Number(index)];
        if (req.headers.authorization)
          return fail(res, 400, "credential_sent_to_storage");
        if (game.putDelayMs)
          await new Promise((resolve) => setTimeout(resolve, game.putDelayMs));
        if (game.refusePuts) return reply(res, 403, undefined);
        if (game.failPuts > 0) {
          game.failPuts -= 1;
          return reply(res, 503, undefined);
        }
        if (
          Object.entries(game.putHeaders).some(
            ([name, value]) => req.headers[name.toLowerCase()] !== value,
          ) ||
          req.headers["content-md5"] !==
            Buffer.from(md5(bytes), "hex").toString("base64") ||
          req.headers["x-goog-content-length-range"] !==
            `${bytes.length},${bytes.length}`
        )
          return reply(res, 400, undefined);
        entry.bytes = bytes;
        game.puts.push(entry.path);
        return reply(res, 200, undefined);
      }
      if (route === "/api/developer/projects/import/") {
        const fields = await form(req, bytes);
        const files = await snapshot(fields, res);
        if (!files) return;
        game.text = files.text;
        game.media = files.media;
        bump();
        record();
        game.releases += 1;
        return reply(res, 201, {
          project_id: PROJECT,
          play_url: "https://example.invalid/p/game",
          claim_url: `https://example.invalid/claim#${"S".repeat(43)}`,
          claim_expires_at: "2030-01-08T12:00:00Z",
          content_version: game.version,
        });
      }
      if (route === `/api/developer/projects/${PROJECT}/connect/`)
        return reply(res, 201, {
          project_id: PROJECT,
          connection_id: randomUUID(),
          agent_token: AGENT,
          approval_url: `https://example.invalid/connect#${"S".repeat(43)}`,
          status: "pending",
          expires_at: "2030-01-01T00:00:00Z",
        });
      if (req.headers.authorization !== `Bearer ${AGENT}`)
        return fail(res, 401, "invalid_connection");
      if (route === `/api/developer/projects/${PROJECT}/connection/`)
        return reply(res, 200, {
          project_id: PROJECT,
          connection_id: randomUUID(),
          status: game.access,
          expires_at: "2030-01-01T00:00:00Z",
          ...(game.access === "active"
            ? {
                content_version: game.version,
                play_url: "https://example.invalid/p/game",
              }
            : {}),
        });
      if (route === `/api/developer/projects/${PROJECT}/files/`) {
        if (!game.sync) return fail(res, 503, "sync_unavailable");
        if (!game.pro)
          return fail(res, 403, "plan_required", {
            message:
              "Reading files back needs code download (https://rosebud.ai/pricing). Publishing still works.",
          });
        record();
        return reply(res, 200, {
          project_id: PROJECT,
          content_version: game.version,
          files: [...game.text]
            .sort()
            .map(([path, content]) => ({ path, content })),
          media: [...game.media].sort().map(([path, data]) => ({
            path,
            url: `/media/${encodeURIComponent(path)}`,
            size: data.length,
            md5: game.hideMd5 ? null : md5(data),
            media_file_id: randomUUID(),
          })),
        });
      }
      if (route === `/api/developer/projects/${PROJECT}/releases/`) {
        const fields = await form(req, bytes);
        const operation = fields.get("operation_id");
        if (game.operations.has(operation))
          return reply(res, 200, game.operations.get(operation));
        if (fields.get("expected_version") !== game.version) {
          const before = game.manifests.get(fields.get("expected_version"));
          const now = manifest();
          const changed = before
            ? [...new Set([...before.keys(), ...now.keys()])]
                .filter((p) => before.get(p) !== now.get(p))
                .sort()
            : null;
          return fail(res, 409, "version_conflict", { changed_paths: changed });
        }
        const files = await snapshot(fields, res);
        if (!files) return;
        game.text = files.text;
        game.media = files.media;
        bump();
        record();
        game.releases += 1;
        const result = {
          project_id: PROJECT,
          operation_id: operation,
          content_version: game.version,
          play_url: "https://example.invalid/p/game",
        };
        game.operations.set(operation, result);
        if (game.loseNextRelease) {
          game.loseNextRelease = false;
          return req.socket.destroy();
        }
        return reply(res, 200, result);
      }
      return fail(res, 404, "not_found");
    } catch (error) {
      return fail(res, 500, "fixture", { detail: String(error) });
    }
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  });
  game.base = base;
  return game;
}
