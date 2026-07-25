import { MongoClient } from 'mongodb';
import env from '../config/env.js';

let client = null;
let database = null;

/**
 * Opens the shared MongoClient. Safe to call more than once — the second call
 * returns the already-connected database.
 */
export async function connectDatabase() {
  if (database) return database;

  client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    ignoreUndefined: true,
  });

  await client.connect();
  database = client.db(env.MONGODB_DB);
  return database;
}

export function getDb() {
  if (!database) {
    throw new Error('Database not connected. Call connectDatabase() during boot.');
  }
  return database;
}

export function getClient() {
  if (!client) {
    throw new Error('Mongo client not initialised. Call connectDatabase() during boot.');
  }
  return client;
}

export async function closeDatabase() {
  if (client) {
    await client.close();
    client = null;
    database = null;
  }
}

/**
 * Multi-document transactions need a replica set. Standalone `mongod` instances
 * (the common local dev setup) reject them, so callers fall back to the plain
 * non-transactional path when this returns false.
 */
export async function withTransaction(fn) {
  const session = getClient().startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
