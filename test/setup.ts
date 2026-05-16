// Shared helpers for storage-layer tests that need a real Mongo connection.
//
// `getTestDb` opens a `MongoClient` against the in-memory server started by
// `test/global-setup.ts` and returns a `Db` handle scoped to a unique name so
// concurrent test files cannot stomp on each other. Each test file owns its
// own client and is responsible for calling `closeTestClient()` in `afterAll`.

import { MongoClient, type Db } from "mongodb";
import { inject } from "vitest";

export interface TestDbHandle {
  client: MongoClient;
  db: Db;
  dbName: string;
}

const clients = new Set<MongoClient>();

export async function getTestDb(dbName?: string): Promise<TestDbHandle> {
  const uri = inject("mongoUri");
  const client = new MongoClient(uri);
  await client.connect();
  clients.add(client);
  const finalName =
    dbName ?? `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return { client, db: client.db(finalName), dbName: finalName };
}

export async function closeTestClient(handle: TestDbHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.db.dropDatabase();
  } catch {
    // Best-effort cleanup; an empty / disconnected DB is harmless.
  }
  await handle.client.close().catch(() => undefined);
  clients.delete(handle.client);
}
