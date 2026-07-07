// expo-sqlite wrapper for the rail_journeys table.
import * as SQLite from 'expo-sqlite';
import type { DbLike } from '../journeys/store-core';
import {
  countRailJourneys,
  ensureRailSchema,
  getRailJourney,
  insertRailJourney,
  listRailJourneys,
  markRailClaimed,
  migrateRailSchema,
  setRailClaimStatus,
  type ClaimStatus,
  type RailJourney,
  type RailOperator,
  type TicketType,
  unmarkRailClaimed,
  updateRailActuals,
} from './store-core';

let _db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (_db) return _db;
  _db = SQLite.openDatabaseSync('rail.db');
  const a: DbLike = {
    execSync: sql => _db!.execSync(sql),
    runSync: (sql, ...p) => _db!.runSync(sql, ...p),
    getAllSync: (sql, ...p) => _db!.getAllSync(sql, ...p),
    getFirstSync: (sql, ...p) => _db!.getFirstSync(sql, ...p),
    withTransactionSync: fn => _db!.withTransactionSync(fn),
  };
  ensureRailSchema(a);
  migrateRailSchema(a); // safe on fresh tables; adds columns if missing
  return _db;
}

function adapter(): DbLike {
  const db = getDb();
  return {
    execSync: sql => db.execSync(sql),
    runSync: (sql, ...p) => db.runSync(sql, ...p),
    getAllSync: (sql, ...p) => db.getAllSync(sql, ...p),
    getFirstSync: (sql, ...p) => db.getFirstSync(sql, ...p),
    withTransactionSync: fn => db.withTransactionSync(fn),
  };
}

export function addRailJourney(j: Omit<RailJourney, 'id'>): number | null {
  return insertRailJourney(adapter(), j, new Date().toISOString());
}

export function getRailJourneyById(id: number): RailJourney | null {
  return getRailJourney(adapter(), id);
}

export function getAllRailJourneys(limit = 100): RailJourney[] {
  return listRailJourneys(adapter(), limit);
}

export function claimRailJourney(id: number): void {
  markRailClaimed(adapter(), id, new Date().toISOString());
}

export function unclaimRailJourney(id: number): void {
  unmarkRailClaimed(adapter(), id);
}

export function updateRailJourneyActuals(
  id: number,
  actualDepart: string | null,
  actualArrive: string | null,
  delayMinutes: number | null,
): void {
  updateRailActuals(adapter(), id, actualDepart, actualArrive, delayMinutes);
}

export function countAllRailJourneys(): number {
  return countRailJourneys(adapter());
}

export function setRailJourneyClaimStatus(id: number, status: ClaimStatus): void {
  setRailClaimStatus(adapter(), id, status);
}

export type { RailJourney, RailOperator, TicketType, ClaimStatus };
