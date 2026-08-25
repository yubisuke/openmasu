import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public final class OpenMmpStorage: @unchecked Sendable {
  public static let directoryName = "OpenMmpSDK"

  public let root: URL
  private let lock = NSRecursiveLock()
  private var database: OpaquePointer?

  public init(root: URL? = nil) throws {
    let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    self.root = root ?? base.appendingPathComponent(Self.directoryName, isDirectory: true)
    try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
    try reassertBackupExclusion()
    let path = self.root.appendingPathComponent("queue.sqlite3").path
    guard sqlite3_open_v2(path, &database, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK
    else { throw OpenMmpError.storage("queue_open_failed") }
    try execute("PRAGMA journal_mode=WAL")
    try execute("PRAGMA synchronous=NORMAL")
    try execute("PRAGMA foreign_keys=ON")
    try execute("PRAGMA secure_delete=ON")
    try execute("""
      CREATE TABLE IF NOT EXISTS queued_events (
        event_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        processing_purpose_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        processing_sequence INTEGER NOT NULL UNIQUE,
        enqueued_at_ms INTEGER NOT NULL
      )
      """)
    try execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    try reassertBackupExclusion()
  }

  deinit { sqlite3_close(database) }

  public func installationId() throws -> String {
    try lock.withLock {
      let url = root.appendingPathComponent("installation-id")
      if let value = try? String(contentsOf: url, encoding: .utf8), !value.isEmpty { return value }
      let value = "installation:\(UUID().uuidString.lowercased())"
      try write(value, to: url)
      return value
    }
  }

  public func replaceInstallationId() throws -> String {
    try lock.withLock {
      let value = "installation:\(UUID().uuidString.lowercased())"
      try write(value, to: root.appendingPathComponent("installation-id"))
      return value
    }
  }

  public func credential() throws -> InstallationCredential? {
    try lock.withLock {
      let url = root.appendingPathComponent("credential.json")
      guard FileManager.default.fileExists(atPath: url.path) else { return nil }
      return try JSONDecoder().decode(InstallationCredential.self, from: Data(contentsOf: url))
    }
  }

  public func setCredential(_ credential: InstallationCredential) throws {
    try lock.withLock {
      let data = try JSONEncoder().encode(credential)
      try write(data, to: root.appendingPathComponent("credential.json"))
    }
  }

  public func isInstallRecorded() throws -> Bool { try metadata("install_recorded") == "1" }
  public func markInstallRecorded() throws { try setMetadata("install_recorded", value: "1") }
  public func isResetPending() throws -> Bool { try metadata("reset_pending") == "1" }
  public func markResetPending() throws { try setMetadata("reset_pending", value: "1") }
  public func clearResetPending() throws {
    try lock.withLock {
      let statement = try prepare("DELETE FROM metadata WHERE key='reset_pending'")
      defer { sqlite3_finalize(statement) }
      guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("reset_pending_clear_failed") }
    }
  }

  public func collectionEnabled(default defaultValue: Bool) throws -> Bool {
    guard let value = try metadata("collection_enabled") else { return defaultValue }
    return value == "1"
  }

  public func setCollectionEnabled(_ enabled: Bool) throws {
    try setMetadata("collection_enabled", value: enabled ? "1" : "0")
  }

  public func nextSequence() throws -> Int64 {
    try lock.withLock {
      try execute("BEGIN IMMEDIATE")
      do {
        let current = Int64(try metadataUnlocked("processing_sequence") ?? "0") ?? 0
        let next = current + 1
        try setMetadataUnlocked("processing_sequence", value: String(next))
        try execute("COMMIT")
        return next
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

  public func enqueue(_ event: QueuedEvent) throws {
    try lock.withLock {
      let statement = try prepare("""
        INSERT INTO queued_events (
          event_id,event_name,processing_purpose_id,payload_json,occurred_at,
          processing_sequence,enqueued_at_ms
        ) VALUES (?,?,?,?,?,?,?)
        """)
      defer { sqlite3_finalize(statement) }
      bind(event.eventId, to: statement, at: 1)
      bind(event.eventName, to: statement, at: 2)
      bind(event.processingPurposeId, to: statement, at: 3)
      bind(event.payloadJson, to: statement, at: 4)
      bind(event.occurredAt, to: statement, at: 5)
      sqlite3_bind_int64(statement, 6, event.processingSequence)
      sqlite3_bind_int64(statement, 7, event.enqueuedAtMs)
      guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("queue_insert_failed") }
      try reassertBackupExclusion()
    }
  }

  public func pending(limit: Int = 100) throws -> [QueuedEvent] {
    try lock.withLock {
      let statement = try prepare("""
        SELECT event_id,event_name,processing_purpose_id,payload_json,occurred_at,
               processing_sequence,enqueued_at_ms
        FROM queued_events ORDER BY processing_sequence LIMIT ?
        """)
      defer { sqlite3_finalize(statement) }
      sqlite3_bind_int(statement, 1, Int32(limit))
      var events: [QueuedEvent] = []
      while sqlite3_step(statement) == SQLITE_ROW {
        events.append(QueuedEvent(
          eventId: text(statement, 0),
          eventName: text(statement, 1),
          processingPurposeId: text(statement, 2),
          payloadJson: text(statement, 3),
          occurredAt: text(statement, 4),
          processingSequence: sqlite3_column_int64(statement, 5),
          enqueuedAtMs: sqlite3_column_int64(statement, 6)
        ))
      }
      return events
    }
  }

  public func delete(eventIds: [String]) throws {
    guard !eventIds.isEmpty else { return }
    try lock.withLock {
      let placeholders = Array(repeating: "?", count: eventIds.count).joined(separator: ",")
      let statement = try prepare("DELETE FROM queued_events WHERE event_id IN (\(placeholders))")
      defer { sqlite3_finalize(statement) }
      for (index, value) in eventIds.enumerated() { bind(value, to: statement, at: Int32(index + 1)) }
      guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("queue_delete_failed") }
    }
  }

  public func purge(processingPurposes: [String]) throws {
    guard !processingPurposes.isEmpty else { return }
    try lock.withLock {
      let placeholders = Array(repeating: "?", count: processingPurposes.count).joined(separator: ",")
      let statement = try prepare("DELETE FROM queued_events WHERE processing_purpose_id IN (\(placeholders))")
      defer { sqlite3_finalize(statement) }
      for (index, value) in processingPurposes.enumerated() { bind(value, to: statement, at: Int32(index + 1)) }
      guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("queue_purge_failed") }
    }
  }

  public func clearForReset() throws {
    try lock.withLock {
      try execute("DELETE FROM queued_events")
      try execute("DELETE FROM metadata")
      for name in ["credential.json", "installation-id"] {
        try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
      }
      try reassertBackupExclusion()
    }
  }

  public func count() throws -> Int {
    try lock.withLock {
      let statement = try prepare("SELECT count(*) FROM queued_events")
      defer { sqlite3_finalize(statement) }
      guard sqlite3_step(statement) == SQLITE_ROW else { throw databaseError("queue_count_failed") }
      return Int(sqlite3_column_int64(statement, 0))
    }
  }

  public func reassertBackupExclusion() throws {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableRoot = root
    try mutableRoot.setResourceValues(values)
    #if os(iOS)
    for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
    }
    #endif
  }

  public func rotateQueueSegment() throws {
    try lock.withLock { try execute("PRAGMA wal_checkpoint(TRUNCATE)") }
    try reassertBackupExclusion()
  }

  public func writtenFiles() throws -> [URL] {
    try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
  }

  private func metadata(_ key: String) throws -> String? { try lock.withLock { try metadataUnlocked(key) } }

  private func metadataUnlocked(_ key: String) throws -> String? {
    let statement = try prepare("SELECT value FROM metadata WHERE key=?")
    defer { sqlite3_finalize(statement) }
    bind(key, to: statement, at: 1)
    return sqlite3_step(statement) == SQLITE_ROW ? text(statement, 0) : nil
  }

  private func setMetadata(_ key: String, value: String) throws {
    try lock.withLock { try setMetadataUnlocked(key, value: value) }
  }

  private func setMetadataUnlocked(_ key: String, value: String) throws {
    let statement = try prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    defer { sqlite3_finalize(statement) }
    bind(key, to: statement, at: 1)
    bind(value, to: statement, at: 2)
    guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("metadata_write_failed") }
  }

  private func write(_ value: String, to url: URL) throws { try write(Data(value.utf8), to: url) }

  private func write(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: .atomic)
    try reassertBackupExclusion()
  }

  private func execute(_ sql: String) throws {
    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw databaseError("sqlite_execute_failed") }
  }

  private func prepare(_ sql: String) throws -> OpaquePointer {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement
    else { throw databaseError("sqlite_prepare_failed") }
    return statement
  }

  private func bind(_ value: String, to statement: OpaquePointer, at index: Int32) {
    sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
  }

  private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
    guard let value = sqlite3_column_text(statement, column) else { return "" }
    return String(cString: value)
  }

  private func databaseError(_ prefix: String) -> OpenMmpError {
    let detail = database.flatMap(sqlite3_errmsg).map { String(cString: $0) } ?? "unknown"
    return OpenMmpError.storage("\(prefix):\(detail)")
  }
}

private extension NSRecursiveLock {
  func withLock<T>(_ work: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try work()
  }
}
