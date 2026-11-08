-- 0001: 初始结构。
--
-- 一张 entity 表容纳全部实体类型：业务字段进 data(JSON)，可演进而不动 DDL；
-- day/parent/status/sort 是查询用的派生列，只有它们变化时才需要迁移。
CREATE TABLE entity (
	kind       TEXT    NOT NULL,
	id         TEXT    NOT NULL,
	updated_at TEXT    NOT NULL,
	deleted_at TEXT    NOT NULL DEFAULT '',
	day        TEXT    NOT NULL DEFAULT '',
	parent     TEXT    NOT NULL DEFAULT '',
	status     INTEGER NOT NULL DEFAULT -1,
	sort       INTEGER NOT NULL DEFAULT 0,
	data       TEXT    NOT NULL,
	PRIMARY KEY (kind, id)
);

CREATE INDEX entity_kind_day    ON entity(kind, day, deleted_at);
CREATE INDEX entity_kind_parent ON entity(kind, parent, deleted_at);
CREATE INDEX entity_updated     ON entity(updated_at);

CREATE TABLE meta (
	key   TEXT NOT NULL PRIMARY KEY,
	value TEXT NOT NULL
);

-- 每个通道一条水位：last_pushed_at 决定增量推送范围，不做 delta 文件。
CREATE TABLE sync_state (
	channel        TEXT NOT NULL PRIMARY KEY,
	last_sync_at   TEXT NOT NULL DEFAULT '',
	last_pushed_at TEXT NOT NULL DEFAULT '',
	note           TEXT NOT NULL DEFAULT ''
);
