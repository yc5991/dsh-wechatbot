import AppKit
import Darwin
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 4, let parent = pid_t(arguments[3]) else { exit(2) }

let files = FileManager.default
let root = URL(fileURLWithPath: arguments[1], isDirectory: true).standardizedFileURL
let id = arguments[2]
let jobDir = root.appendingPathComponent("dsh-wechatbot/pending-deletions", isDirectory: true)
let jobPath = jobDir.appendingPathComponent(id + ".json")
let isRealProfile = root.resolvingSymlinksInPath().path == files.homeDirectoryForCurrentUser
    .appendingPathComponent(".dsh").resolvingSymlinksInPath().path

func valid(_ component: String) -> Bool {
    return component.range(of: "^[a-zA-Z0-9_-]{1,160}$", options: .regularExpression) != nil
}

func validBucket(_ component: String) -> Bool {
    return component != "." && component != ".."
        && component.range(of: "^[a-zA-Z0-9_.-]{1,255}$", options: .regularExpression) != nil
}

func load() throws -> [String: Any] {
    let data = try Data(contentsOf: jobPath)
    guard let job = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          job["id"] as? String == id, let bucket = job["bucket"] as? String, validBucket(bucket) else {
        throw Failure("删除记录无效")
    }
    return job
}

func write(_ job: [String: Any]) throws {
    try JSONSerialization.data(withJSONObject: job).write(to: jobPath, options: .atomic)
}

struct Failure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func hostIsUp() -> Bool {
    if kill(parent, 0) == 0 || errno == EPERM { return true }
    return isRealProfile && !NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh").isEmpty
}

func checkPath(_ url: URL, under expectedRoot: URL) throws {
    let base = expectedRoot.resolvingSymlinksInPath().path
    let path = url.resolvingSymlinksInPath().path
    guard path.hasPrefix(base + "/"), path == base + "/" + url.path.dropFirst(expectedRoot.path.count + 1) else {
        throw Failure("存储路径发生变化")
    }
}

func withLock(_ url: URL, create: Bool = false, _ body: () throws -> Void) throws {
    let flags = O_RDWR | O_NOFOLLOW | (create ? O_CREAT : 0)
    let fd = open(url.path, flags, 0o600)
    guard fd >= 0 else { throw Failure("无法打开会话锁") }
    defer { close(fd) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure("会话锁仍被使用") }
    var held = stat(), current = stat()
    guard fstat(fd, &held) == 0, lstat(url.path, &current) == 0, held.st_ino == current.st_ino,
          held.st_dev == current.st_dev, (held.st_mode & S_IFMT) == S_IFREG else { throw Failure("会话锁已变化") }
    try body()
}

guard valid(id), parent > 1 else { exit(2) }
do {
    try withLock(jobDir.appendingPathComponent(id + ".worker-lock"), create: true) {
        var job = try load()
        guard job["stage"] as? String == "waiting" else { return }
        while hostIsUp() { Thread.sleep(forTimeInterval: 0.65) }
        Thread.sleep(forTimeInterval: 0.8)
        while hostIsUp() { Thread.sleep(forTimeInterval: 0.65) }

        let sessionRoot = root.appendingPathComponent("sessions", isDirectory: true)
        let cacheRoot = root.appendingPathComponent("storages/session_projcache/sessions", isDirectory: true)
        let session = sessionRoot.appendingPathComponent(job["bucket"] as! String, isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
        let cache = cacheRoot.appendingPathComponent(id + ".json")
        let stagedSession = jobDir.appendingPathComponent(id + ".session", isDirectory: true)
        let stagedCache = jobDir.appendingPathComponent(id + ".projection")
        do {
            try checkPath(session, under: sessionRoot)
            try checkPath(cache, under: cacheRoot)
            try checkPath(stagedSession, under: jobDir)
            try checkPath(stagedCache, under: jobDir)
            if files.fileExists(atPath: session.path) {
                try withLock(session.appendingPathComponent("session.lock", isDirectory: false)) {
                    guard !hostIsUp() else { throw Failure("DSH 已重新打开，请退出后重试") }
                    guard try files.contentsOfDirectory(atPath: session.path).contains(where: {
                        $0.hasSuffix(".jsonl") || $0.hasSuffix(".jsonl.zstd")
                    }) else { throw Failure("找不到已验证的会话日志") }
                    try files.moveItem(at: session, to: stagedSession)
                }
            }
            guard !hostIsUp() else { throw Failure("DSH 已重新打开，请退出后重试") }
            if files.fileExists(atPath: cache.path) { try files.moveItem(at: cache, to: stagedCache) }
            guard !hostIsUp() else { throw Failure("DSH 已重新打开，请退出后重试") }
            for staged in [stagedSession, stagedCache] where files.fileExists(atPath: staged.path) {
                try files.removeItem(at: staged)
            }
            job["stage"] = "purged"
            job.removeValue(forKey: "error")
            try write(job)
        } catch {
            job["error"] = error.localizedDescription
            try write(job)
        }
    }
} catch { exit(1) }
