-- One listener say per request per event. Claimed before POST /dj/say.
-- A failed send is not cleared, so a retry or restart does not send it again.

CREATE TABLE IF NOT EXISTS listener_say_events (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, event)
);
