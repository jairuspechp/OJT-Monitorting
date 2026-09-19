-- Link Layouts schema (MySQL 5.7+ / 8.x / MariaDB)
-- server.js creates the database and runs this file automatically on start.
-- To run manually:  CREATE DATABASE link_layouts; then  mysql link_layouts < schema.sql

CREATE TABLE IF NOT EXISTS boards (
  id          VARCHAR(40)  NOT NULL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  layout_mode VARCHAR(20)  NOT NULL DEFAULT 'standard',
  slot_count  INT          NOT NULL DEFAULT 4,
  created_at  BIGINT       NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS slots (
  board_id   VARCHAR(40)   NOT NULL,
  slot_index INT           NOT NULL,
  label      VARCHAR(255)  NOT NULL DEFAULT '',
  url        VARCHAR(2048) NOT NULL,
  PRIMARY KEY (board_id, slot_index),
  CONSTRAINT fk_slots_board FOREIGN KEY (board_id)
    REFERENCES boards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
