# MongoDB support, with basic vector search

Roadmap 0.9.0, item 2 (`.scratchpad/roadmap.md`). The last database added for now.

## Goal

Connect to MongoDB, browse it, read documents with a filter or an aggregation pipeline, run a
vector search, and delete documents. Nothing more: no inserting or editing documents, no index
management, no schema validation, change streams or GridFS.

## Shape

MongoDB is not SQL, so it follows the Redis pattern, not the relational adapters:

- **Core:** `crates/tpm-core/src/mongo.rs`, a `MongoSession` on the official `mongodb` crate
  (3.9, Apache-2.0, rustls with ring like the rest of the app). The engine keeps open sessions
  in a map by id, as it does for Redis (`mongo_open`, `mongo`, `mongo_close`).
- **Commands:** `src-tauri/src/commands/mongo.rs`.
- **UI:** a `mongo` workspace kind and `src/features/mongo/MongoView.tsx`; the SQL editor, grid
  and restore points are not used.

## Connections

- `Driver::Mongodb` (serialised `mongodb`), default port 27017.
- URLs: `mongodb://user:pass@host:port/db?authSource=admin&tls=true` and `mongodb+srv://…`.
  Two optional profile fields keep what the URL says: `srv` (look up hosts through DNS, as Atlas
  needs) and `authSource`. Several hosts (replica sets) are not supported in this version: one host,
  or SRV.
- TLS: Disable = no TLS; Require = TLS, certificate verified; Require (don't verify) = TLS without
  verification; Prefer = verified TLS with SRV (Atlas requires it) and none without, since
  MongoDB has no "TLS if offered". A CA file maps to `tlsCAFile`.
- SSH tunnel: one host, `directConnection=true`. SRV with SSH is refused (SRV resolves to several
  hosts), and so is verified TLS through a tunnel (the certificate names the real host, not the
  tunnel's end); TLS without verification works. Both are refused before the tunnel opens.
- Passwords: the credential store, as for every other driver. The profile never holds one; a
  password in a pasted URL goes to the store.

## Reading

- **Browse:** databases (with sizes), then collections and views with estimated counts.
- **Find:** filter, sort and projection as JSON (MongoDB Extended JSON, relaxed: `{"_id":
  {"$oid": "…"}}`, `{"$date": "…"}`), with skip and limit (page size capped at 1,000).
  Documents come back as relaxed Extended JSON text, shown as a list with each document's
  `_id` and expandable JSON, plus a table of the top-level fields.
- **Aggregate:** a pipeline as a JSON array. Only reading stages: a pipeline with `$out` or
  `$merge` is refused (writes are out of scope), wherever the stage appears.
- **Vector search:** a form for index name, vector field, query vector (a JSON array of
  numbers), number of candidates (default 10 × limit), limit and an optional filter. The core
  builds the pipeline, so the stage is always well formed:
  `[{"$vectorSearch": {...}}, {"$addFields": {"_score": {"$meta": "vectorSearchScore"}}}]`, and
  results show `_score`. `$vectorSearch` needs Atlas, or the `mongodb/mongodb-atlas-local` image.
- Every read has a time limit (the connection's query timeout, else 30 s) sent as `maxTimeMS`.
  Results larger than 16 MB in total are truncated with a note.

## Deleting

- Delete the selected documents (by `_id`) or the documents a filter matches.
- Two steps, both checked in the backend: `mongo_delete_count` counts what would go; the delete
  carries that count and runs only if the confirmation matches. A confirmation always shows the
  count; an empty filter (every document) says so in words.
- Read-only connections refuse deletes, and so do production connections opened read-only
  (the "Open production read-only" setting) until writes are allowed for the session. On
  production, deleting by filter asks for the connection name to be typed, as destructive SQL
  does.
- No restore points for MongoDB in this version: the confirmation says the delete can't be
  undone.

## Safety

- Values are never pasted into anything: filters and pipelines are parsed into BSON documents
  and sent as such. Database, collection and index names and field paths are API parameters of
  the driver, never put into query text, so there is nothing to quote. `system.*` collections are
  hidden in the tree and never deleted from.
- Logs never include connection strings, filters, pipelines or documents.

## Testing

- Unit: URL parsing (both schemes, auth source, TLS options, a password never in the profile),
  Extended JSON parsing errors, `$out`/`$merge` detection at any depth, vector stage building
  and validation (non-numeric vectors, empty vectors, limits), delete confirmation rules.
- Integration (`mongo` test, `TPM_TEST_MONGO_URL`): a disposable `tpm-test-mongo` container
  (`mongo:7`) for browse, find, aggregate, delete and read-only refusal; vector search against
  `tpm-test-mongo-atlas` (`mongodb/mongodb-atlas-local`), creating a small vector index in the
  test. A missing URL prints `BLOCKED`, never a pass.
- Manual: the app under Xvfb against both containers.
