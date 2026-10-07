import sqlite3
from datetime import datetime
from decimal import Decimal


SQLITE_SCHEMA = """
CREATE TABLE listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_listing_id TEXT,
    canonical_url TEXT,
    identity_key TEXT NOT NULL,
    title TEXT,
    property_type TEXT,
    address TEXT,
    neighborhood TEXT,
    city TEXT,
    latitude REAL,
    longitude REAL,
    location_precision TEXT NOT NULL DEFAULT 'source',
    area_m2 NUMERIC,
    bedrooms NUMERIC,
    bathrooms NUMERIC,
    parking_spaces NUMERIC,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    current_status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source, identity_key)
);
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    observed_at TEXT NOT NULL,
    rent_price NUMERIC,
    condo_fee NUMERIC,
    iptu NUMERIC,
    total_price NUMERIC,
    price_m2 NUMERIC,
    available INTEGER NOT NULL DEFAULT 1,
    UNIQUE (listing_id, observed_at)
);
CREATE TABLE collection_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    records_found INTEGER NOT NULL DEFAULT 0,
    records_new INTEGER NOT NULL DEFAULT 0,
    records_updated INTEGER NOT NULL DEFAULT 0,
    records_missing INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    metrics_json TEXT NOT NULL DEFAULT '{}'
);
"""


class SQLiteCursorAdapter:
    def __init__(self, cursor):
        self.cursor = cursor

    def execute(self, sql, values=()):
        params = tuple(_sqlite_value(value) for value in values)
        self.cursor.execute(sql.replace("%s", "?"), params)
        return self

    def fetchone(self):
        return self.cursor.fetchone()

    def fetchall(self):
        return self.cursor.fetchall()

    def close(self):
        self.cursor.close()


class SQLiteConnectionAdapter:
    """DB-API shim so repository behavior can be exercised without a server."""

    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.executescript(SQLITE_SCHEMA)

    def cursor(self):
        return SQLiteCursorAdapter(self.connection.cursor())

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def close(self):
        self.connection.close()


def _sqlite_value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return value
