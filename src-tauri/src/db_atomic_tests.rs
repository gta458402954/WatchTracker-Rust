#[cfg(test)]
mod tests {
    use crate::db;
    use crate::db_atomic_crud::{
        delete_record_atomic, insert_record_atomic, replace_all_records_atomic,
    };
    use crate::db_atomic_helpers::{
        get_records_generation, get_tombstones_tx, set_setting_tx, Tombstone,
    };
    use crate::db_atomic_update::update_record_atomic;
    use crate::models::{Patch, RecordStatus, UpdateWatchRecord, WatchRecord};
    use rusqlite::Connection;

    fn record(id: &str) -> WatchRecord {
        WatchRecord {
            id: id.to_string(),
            original_name: "Original".to_string(),
            chinese_name: "原始记录".to_string(),
            progress: "0".to_string(),
            total_episodes: Some(10),
            movie_progress: None,
            movie_duration: None,
            release_year: Some("2026".to_string()),
            poster_path: None,
            status: RecordStatus::Unwatched,
            platform: String::new(),
            rating: None,
            start_date: None,
            end_date: None,
            notes: String::new(),
            created_at: "2026-07-28T00:00:00.000Z".to_string(),
            updated_at: Some("2026-07-28T00:00:00.000Z".to_string()),
            imdb_id: None,
            is_locked: Some(false),
            genres: None,
            origin_country: None,
            imdb_rating: None,
            tmdb_status: None,
            interest_level: None,
            episode_runtime: None,
            media_type: "电影".to_string(),
            content_tags: None,
            rev: 2,
            rev_actor: "old-actor".to_string(),
        }
    }

    fn database() -> Connection {
        let connection = Connection::open_in_memory().expect("open test database");
        db::setup_db(&connection).expect("create current schema");
        connection
    }

    fn state(conn: &Connection, id: &str) -> (String, Option<String>, i64, String, i64) {
        conn.query_row(
            "SELECT progress, updatedAt, rev, revActor, \
             CAST((SELECT value FROM settings WHERE key = 'records_generation') AS INTEGER) \
             FROM records WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("read record state")
    }

    #[test]
    fn insert_commits_record_tombstone_cleanup_and_generation_together() {
        let mut conn = database();
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"inserted","deletedAt":"2026-07-28T01:00:00Z"},{"id":"other","deletedAt":"2026-07-28T02:00:00Z"}]"#,
        )
        .expect("seed tombstones");

        insert_record_atomic(&mut conn, record("inserted")).expect("insert record");

        assert!(db::get_record(&conn, "inserted").unwrap().is_some());
        assert_eq!(get_records_generation(&conn).unwrap(), 1);
        assert_eq!(
            get_tombstones_tx(&conn).unwrap(),
            vec![Tombstone {
                id: "other".to_string(),
                deleted_at: "2026-07-28T02:00:00Z".to_string(),
            }]
        );
    }

    #[test]
    fn delete_commits_record_tombstone_and_generation_together() {
        let mut conn = database();
        db::insert_record(&conn, record("deleted")).expect("seed record");

        delete_record_atomic(&mut conn, "deleted").expect("delete record");

        assert!(db::get_record(&conn, "deleted").unwrap().is_none());
        assert_eq!(get_records_generation(&conn).unwrap(), 1);
        let tombstones = get_tombstones_tx(&conn).unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].id, "deleted");
        assert!(!tombstones[0].deleted_at.is_empty());
    }

    #[test]
    fn insert_generation_failure_rolls_back_record_and_tombstone_cleanup() {
        let mut conn = database();
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"insert-failure","deletedAt":"2026-07-28T01:00:00Z"}]"#,
        )
        .unwrap();
        let tombstones = get_tombstones_tx(&conn).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_insert_generation BEFORE UPDATE OF value ON settings
             WHEN OLD.key = 'records_generation'
             BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END;",
        )
        .unwrap();

        assert!(insert_record_atomic(&mut conn, record("insert-failure")).is_err());
        assert!(db::get_record(&conn, "insert-failure").unwrap().is_none());
        assert_eq!(get_records_generation(&conn).unwrap(), 0);
        assert_eq!(get_tombstones_tx(&conn).unwrap(), tombstones);
    }

    #[test]
    fn delete_generation_failure_rolls_back_record_and_tombstone() {
        let mut conn = database();
        db::insert_record(&conn, record("delete-failure")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_delete_generation BEFORE UPDATE OF value ON settings
             WHEN OLD.key = 'records_generation'
             BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END;",
        )
        .unwrap();

        assert!(delete_record_atomic(&mut conn, "delete-failure").is_err());
        assert!(db::get_record(&conn, "delete-failure").unwrap().is_some());
        assert_eq!(get_records_generation(&conn).unwrap(), 0);
        assert!(get_tombstones_tx(&conn).unwrap().is_empty());
    }

    #[test]
    fn replace_all_records_commits_once_and_preserves_locked_records() {
        let mut conn = database();
        let mut locked = record("locked");
        locked.is_locked = Some(true);
        db::insert_record(&conn, locked).unwrap();
        db::insert_record(&conn, record("old")).unwrap();

        replace_all_records_atomic(&mut conn, vec![record("locked"), record("imported")]).unwrap();

        assert!(db::get_record(&conn, "locked").unwrap().is_some());
        assert!(db::get_record(&conn, "imported").unwrap().is_some());
        assert!(db::get_record(&conn, "old").unwrap().is_none());
        assert_eq!(get_records_generation(&conn).unwrap(), 1);
    }

    #[test]
    fn replace_all_records_failure_rolls_back_records_and_generation() {
        let mut conn = database();
        db::insert_record(&conn, record("original")).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_import BEFORE INSERT ON records
             WHEN NEW.id = 'bad-import'
             BEGIN SELECT RAISE(ABORT, 'injected import failure'); END;",
        )
        .unwrap();

        assert!(replace_all_records_atomic(
            &mut conn,
            vec![record("replacement"), record("bad-import")],
        )
        .is_err());
        assert!(db::get_record(&conn, "original").unwrap().is_some());
        assert!(db::get_record(&conn, "replacement").unwrap().is_none());
        assert_eq!(get_records_generation(&conn).unwrap(), 0);
    }

    #[test]
    fn update_payload_rejects_unknown_system_and_invalid_value_types() {
        for field in [
            "id",
            "createdAt",
            "updatedAt",
            "rev",
            "revActor",
            "unknownField",
        ] {
            let error = serde_json::from_value::<UpdateWatchRecord>(serde_json::json!({field: 1}))
                .expect_err("system and unknown fields must be rejected");
            assert!(
                error.to_string().contains("unknown field"),
                "{field}: {error}"
            );
        }
        for value in [serde_json::json!([]), serde_json::json!({"nested": true})] {
            assert!(serde_json::from_value::<UpdateWatchRecord>(
                serde_json::json!({"rating": value})
            )
            .is_err());
        }
        assert!(
            serde_json::from_value::<UpdateWatchRecord>(serde_json::json!({"rating": "ten"}))
                .is_err()
        );
    }

    #[test]
    fn empty_update_is_rejected_without_side_effects() {
        let mut conn = database();
        db::insert_record(&conn, record("empty")).expect("seed record");
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"empty","deletedAt":"2026-07-28T01:00:00Z"}]"#,
        )
        .expect("seed tombstone");
        let before = state(&conn, "empty");
        let tombstones = get_tombstones_tx(&conn).expect("read tombstones");

        let error =
            update_record_atomic(&mut conn, "empty", &UpdateWatchRecord::default(), "actor")
                .expect_err("empty update must fail");

        assert!(error.to_string().contains("Empty update payload"));
        assert_eq!(state(&conn, "empty"), before);
        assert_eq!(get_tombstones_tx(&conn).unwrap(), tombstones);
    }

    #[test]
    fn update_uses_rust_time_and_commits_record_tombstone_and_generation_together() {
        let mut conn = database();
        db::insert_record(&conn, record("updated")).expect("seed record");
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"updated","deletedAt":"2026-07-28T01:00:00Z"},{"id":"other","deletedAt":"2026-07-28T02:00:00Z"}]"#,
        )
        .expect("seed tombstones");
        let old_updated_at = db::get_record(&conn, "updated")
            .unwrap()
            .unwrap()
            .updated_at
            .unwrap();
        let updates = UpdateWatchRecord {
            progress: Some("5".to_string()),
            rating: Patch::Value(9),
            ..Default::default()
        };

        let persisted = update_record_atomic(&mut conn, "updated", &updates, "rust-actor")
            .expect("atomic update");

        assert_eq!(persisted.progress, "5");
        assert_eq!(persisted.rating, Some(9));
        assert_eq!(persisted.rev, 3);
        assert_eq!(persisted.rev_actor, "rust-actor");
        assert_ne!(
            persisted.updated_at.as_deref(),
            Some(old_updated_at.as_str())
        );
        assert_eq!(get_records_generation(&conn).unwrap(), 1);
        assert_eq!(
            get_tombstones_tx(&conn).unwrap(),
            vec![Tombstone {
                id: "other".to_string(),
                deleted_at: "2026-07-28T02:00:00Z".to_string(),
            }]
        );
    }

    #[test]
    fn setting_failure_rolls_back_record_tombstone_and_generation() {
        let mut conn = database();
        db::insert_record(&conn, record("rollback")).expect("seed record");
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"rollback","deletedAt":"2026-07-28T01:00:00Z"}]"#,
        )
        .expect("seed tombstone");
        conn.execute_batch(
            "CREATE TRIGGER fail_generation BEFORE UPDATE OF value ON settings
             WHEN OLD.key = 'records_generation'
             BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END;",
        )
        .expect("install failure trigger");
        let before = state(&conn, "rollback");
        let tombstones = get_tombstones_tx(&conn).unwrap();

        let result = update_record_atomic(
            &mut conn,
            "rollback",
            &UpdateWatchRecord {
                progress: Some("9".to_string()),
                ..Default::default()
            },
            "actor",
        );

        assert!(result.is_err());
        assert_eq!(state(&conn, "rollback"), before);
        assert_eq!(get_tombstones_tx(&conn).unwrap(), tombstones);
    }

    #[test]
    fn record_sql_failure_leaves_all_atomic_state_unchanged() {
        let mut conn = database();
        db::insert_record(&conn, record("sql-failure")).expect("seed record");
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"sql-failure","deletedAt":"2026-07-28T01:00:00Z"}]"#,
        )
        .expect("seed tombstone");
        conn.execute_batch(
            "CREATE TRIGGER fail_record_update BEFORE UPDATE ON records
             WHEN OLD.id = 'sql-failure'
             BEGIN SELECT RAISE(ABORT, 'injected record failure'); END;",
        )
        .expect("install record failure trigger");
        let before = state(&conn, "sql-failure");
        let tombstones = get_tombstones_tx(&conn).unwrap();

        let result = update_record_atomic(
            &mut conn,
            "sql-failure",
            &UpdateWatchRecord {
                progress: Some("8".to_string()),
                ..Default::default()
            },
            "actor",
        );

        assert!(result.is_err());
        assert_eq!(state(&conn, "sql-failure"), before);
        assert_eq!(get_tombstones_tx(&conn).unwrap(), tombstones);
    }

    #[test]
    fn missing_record_preserves_existing_tombstone_and_generation() {
        let mut conn = database();
        set_setting_tx(
            &conn,
            "sync_tombstones",
            r#"[{"id":"missing","deletedAt":"2026-07-28T01:00:00Z"}]"#,
        )
        .expect("seed tombstone");
        let tombstones = get_tombstones_tx(&conn).unwrap();
        let generation = get_records_generation(&conn).unwrap();

        let error = update_record_atomic(
            &mut conn,
            "missing",
            &UpdateWatchRecord {
                progress: Some("1".to_string()),
                ..Default::default()
            },
            "actor",
        )
        .expect_err("missing record must fail");

        assert!(error.to_string().contains("Record not found"));
        assert_eq!(get_tombstones_tx(&conn).unwrap(), tombstones);
        assert_eq!(get_records_generation(&conn).unwrap(), generation);
    }

    #[test]
    fn migration_version_write_failure_rolls_back_schema_and_can_retry() {
        let conn = database();
        conn.execute("ALTER TABLE records ADD COLUMN category TEXT", [])
            .expect("add legacy category");
        conn.execute("ALTER TABLE records ADD COLUMN sortOrder INTEGER", [])
            .expect("add legacy sort order");
        conn.execute(
            "UPDATE settings SET value = '13' WHERE key = 'db_version'",
            [],
        )
        .expect("set v13");
        conn.execute_batch(
            "CREATE TRIGGER fail_v14_version BEFORE INSERT ON settings
             WHEN NEW.key = 'db_version' AND NEW.value = '14'
             BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;",
        )
        .expect("install migration trigger");

        assert!(db::setup_db(&conn).is_err());
        let records_table: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'records'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let temporary_table: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'records_v14'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(records_table, 1);
        assert_eq!(temporary_table, 0);
        assert_eq!(
            db::get_setting(&conn, "db_version".to_string())
                .unwrap()
                .as_deref(),
            Some("13")
        );

        conn.execute("DROP TRIGGER fail_v14_version", [])
            .expect("remove migration trigger");
        db::setup_db(&conn).expect("retry migrations");
        assert_eq!(
            db::get_setting(&conn, "db_version".to_string())
                .unwrap()
                .as_deref(),
            Some("18")
        );
    }

    #[test]
    fn v17_migration_is_atomic_and_retryable() {
        let conn = database();
        conn.execute("ALTER TABLE records DROP COLUMN revActor", [])
            .expect("remove v18 column");
        conn.execute("ALTER TABLE records DROP COLUMN rev", [])
            .expect("remove v17 column");
        conn.execute("DELETE FROM settings WHERE key = 'records_generation'", [])
            .unwrap();
        conn.execute(
            "UPDATE settings SET value = '16' WHERE key = 'db_version'",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_v17_version BEFORE INSERT ON settings
             WHEN NEW.key = 'db_version' AND NEW.value = '17'
             BEGIN SELECT RAISE(ABORT, 'injected v17 failure'); END;",
        )
        .unwrap();

        assert!(db::setup_db(&conn).is_err());
        let rev_exists: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('records') WHERE name = 'rev'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rev_exists, 0);
        assert_eq!(
            db::get_setting(&conn, "db_version".to_string())
                .unwrap()
                .as_deref(),
            Some("16")
        );

        conn.execute("DROP TRIGGER fail_v17_version", []).unwrap();
        db::setup_db(&conn).expect("retry v17 and v18");
        assert_eq!(
            db::get_setting(&conn, "db_version".to_string())
                .unwrap()
                .as_deref(),
            Some("18")
        );
    }

    #[test]
    fn v18_migration_is_atomic_and_retryable() {
        let conn = database();
        conn.execute("ALTER TABLE records DROP COLUMN revActor", [])
            .expect("remove v18 column");
        conn.execute("DELETE FROM settings WHERE key = 'records_generation'", [])
            .unwrap();
        conn.execute(
            "UPDATE settings SET value = '17' WHERE key = 'db_version'",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_v18_version BEFORE INSERT ON settings
             WHEN NEW.key = 'db_version' AND NEW.value = '18'
             BEGIN SELECT RAISE(ABORT, 'injected v18 failure'); END;",
        )
        .unwrap();

        assert!(db::setup_db(&conn).is_err());
        let rev_actor_exists: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('records') WHERE name = 'revActor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rev_actor_exists, 0);
        assert!(db::get_setting(&conn, "records_generation".to_string())
            .unwrap()
            .is_none());

        conn.execute("DROP TRIGGER fail_v18_version", []).unwrap();
        db::setup_db(&conn).expect("retry v18");
        assert_eq!(
            db::get_setting(&conn, "db_version".to_string())
                .unwrap()
                .as_deref(),
            Some("18")
        );
        assert_eq!(
            db::get_setting(&conn, "records_generation".to_string())
                .unwrap()
                .as_deref(),
            Some("0")
        );
    }

    #[test]
    fn get_setting_only_maps_missing_rows_to_none() {
        let conn = database();
        assert!(db::get_setting(&conn, "missing".to_string())
            .unwrap()
            .is_none());

        let broken = Connection::open_in_memory().expect("open database without schema");
        assert!(db::get_setting(&broken, "missing".to_string()).is_err());
    }
}
