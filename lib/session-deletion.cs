using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public static class SessionDeleteWorker
{
    private static readonly Regex IdPattern = new Regex("^[a-zA-Z0-9_-]{1,160}$", RegexOptions.Compiled);
    private static readonly Regex BucketPattern = new Regex("^[a-zA-Z0-9_.-]{1,255}$", RegexOptions.Compiled);

    private static bool ValidId(string value)
    {
        return !string.IsNullOrEmpty(value) && IdPattern.IsMatch(value);
    }

    private static bool ValidBucket(string value)
    {
        return !string.IsNullOrEmpty(value) && value != "." && value != ".." && BucketPattern.IsMatch(value);
    }

    private static string NormalizeDir(string path)
    {
        return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void CheckUnder(string targetPath, string expectedRoot)
    {
        string root = NormalizeDir(expectedRoot) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(targetPath);
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("存储路径发生变化");
        }
        FileInfo fi = new FileInfo(full);
        if ((fi.Exists || Directory.Exists(full)) && (fi.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException("拒绝操作重解析点或符号链接");
        }
    }

    private static bool HostIsUp(int parentPid, bool isRealProfile)
    {
        try
        {
            using (Process p = Process.GetProcessById(parentPid))
            {
                if (!p.HasExited) return true;
            }
        }
        catch (ArgumentException) { }
        catch { return true; }

        if (isRealProfile)
        {
            foreach (string procName in new string[] { "DeepSeek Harness", "dsh" })
            {
                try
                {
                    Process[] list = Process.GetProcessesByName(procName);
                    bool any = list.Length > 0;
                    foreach (Process item in list) item.Dispose();
                    if (any) return true;
                }
                catch { }
            }
        }
        return false;
    }

    private static void WriteAtomic(string jobPath, Dictionary<string, object> job)
    {
        JavaScriptSerializer s = new JavaScriptSerializer();
        string tmp = jobPath + "." + Process.GetCurrentProcess().Id + ".tmp";
        try
        {
            File.WriteAllText(tmp, s.Serialize(job), new UTF8Encoding(false));
            if (File.Exists(jobPath)) File.Delete(jobPath);
            File.Move(tmp, jobPath);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
        }
    }

    public static int Main(string[] args)
    {
        if (args.Length != 3) return 2;
        int parentPid;
        if (!int.TryParse(args[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out parentPid) || parentPid <= 1)
            return 2;

        string root = NormalizeDir(args[0]);
        string id = args[1];
        if (!ValidId(id)) return 2;

        string jobDir = Path.Combine(root, "dsh-wechatbot", "pending-deletions");
        string jobPath = Path.Combine(jobDir, id + ".json");
        string workerLockPath = Path.Combine(jobDir, id + ".worker-lock");

        string userHome = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string realDsh = NormalizeDir(Path.Combine(userHome, ".dsh"));
        bool isRealProfile = string.Equals(root, realDsh, StringComparison.OrdinalIgnoreCase);

        try
        {
            Directory.CreateDirectory(jobDir);
            using (FileStream workerLock = new FileStream(workerLockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                JavaScriptSerializer s = new JavaScriptSerializer();
                Dictionary<string, object> job = s.Deserialize<Dictionary<string, object>>(File.ReadAllText(jobPath, Encoding.UTF8));
                if (job == null || (job.ContainsKey("id") ? Convert.ToString(job["id"]) : "") != id)
                    throw new InvalidOperationException("删除记录无效");
                string bucket = job.ContainsKey("bucket") ? Convert.ToString(job["bucket"]) : "";
                if (!ValidBucket(bucket))
                    throw new InvalidOperationException("删除记录无效");
                string stage = job.ContainsKey("stage") ? Convert.ToString(job["stage"]) : "";
                if (stage != "waiting") return 0;

                while (HostIsUp(parentPid, isRealProfile)) Thread.Sleep(450);
                Thread.Sleep(550);
                while (HostIsUp(parentPid, isRealProfile)) Thread.Sleep(450);

                string sessionRoot = Path.Combine(root, "sessions");
                string cacheRoot = Path.Combine(root, "storages", "session_projcache", "sessions");
                string session = Path.Combine(sessionRoot, bucket, id);
                string cache = Path.Combine(cacheRoot, id + ".json");
                string stagedSession = Path.Combine(jobDir, id + ".session");
                string stagedCache = Path.Combine(jobDir, id + ".projection");

                try
                {
                    CheckUnder(session, sessionRoot);
                    CheckUnder(cache, cacheRoot);
                    CheckUnder(stagedSession, jobDir);
                    CheckUnder(stagedCache, jobDir);

                    if (Directory.Exists(session))
                    {
                        string lockFile = Path.Combine(session, "session.lock");
                        if (!File.Exists(lockFile)) throw new InvalidOperationException("无法打开会话锁");
                        using (FileStream sessionLock = new FileStream(lockFile, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                        {
                            if (HostIsUp(parentPid, isRealProfile))
                                throw new InvalidOperationException("DSH 已重新打开，请退出后重试");
                            string[] entries = Directory.GetFiles(session);
                            bool hasLog = false;
                            foreach (string entry in entries)
                            {
                                if (entry.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase)
                                    || entry.EndsWith(".jsonl.zstd", StringComparison.OrdinalIgnoreCase))
                                {
                                    hasLog = true;
                                    break;
                                }
                            }
                            if (!hasLog) throw new InvalidOperationException("找不到已验证的会话日志");
                        }
                        if (HostIsUp(parentPid, isRealProfile))
                            throw new InvalidOperationException("DSH 已重新打开，请退出后重试");
                        if (Directory.Exists(stagedSession)) Directory.Delete(stagedSession, true);
                        Directory.Move(session, stagedSession);
                    }

                    if (HostIsUp(parentPid, isRealProfile))
                    {
                        if (Directory.Exists(stagedSession) && !Directory.Exists(session))
                            Directory.Move(stagedSession, session);
                        throw new InvalidOperationException("DSH 已重新打开，请退出后重试");
                    }

                    if (File.Exists(cache))
                    {
                        if (File.Exists(stagedCache)) File.Delete(stagedCache);
                        File.Move(cache, stagedCache);
                    }

                    if (HostIsUp(parentPid, isRealProfile))
                        throw new InvalidOperationException("DSH 已重新打开，请退出后重试");

                    if (Directory.Exists(stagedSession)) Directory.Delete(stagedSession, true);
                    if (File.Exists(stagedCache)) File.Delete(stagedCache);

                    job["stage"] = "purged";
                    job.Remove("error");
                    WriteAtomic(jobPath, job);
                }
                catch (Exception inner)
                {
                    job["error"] = inner.Message;
                    WriteAtomic(jobPath, job);
                }
            }
            return 0;
        }
        catch
        {
            return 1;
        }
    }
}
