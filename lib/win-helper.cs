using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public static class Program
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const ushort VK_BACK = 0x08;
    private const ushort VK_RETURN = 0x0D;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_ESCAPE = 0x1B;
    private const ushort VK_A = 0x41;
    private const ushort VK_C = 0x43;
    private const ushort VK_V = 0x56;

    private const int SW_RESTORE = 9;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_GETOBJECT = 0x003D;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private const uint PW_RENDERFULLCONTENT = 0x00000002;

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT Point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);

    private static readonly Random Rng = new Random();

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;
    private const uint GA_ROOT = 2;

    private static readonly string SmileMask =
        "................." +
        "........#........" +
        ".....##...##....." +
        "....#.......#...." +
        "...#.........#..." +
        "..#...#...#...#.." +
        "..#..##...##..#.." +
        "..#...#...#...#.." +
        ".#.............#." +
        "..#..#######..#.." +
        "..#..#.....#..#.." +
        "..#..##...##..#.." +
        "...#...###...#..." +
        "....#.......#...." +
        ".....##..###....." +
        "........#........" +
        ".................";

    private static readonly string HeartMask =
        "................." +
        "................." +
        ".....##...##....." +
        "...#####.#####..." +
        "..##....#....##.." +
        "..#...........#.." +
        "..#...........#.." +
        "..##.........##.." +
        "...#.........#..." +
        "...##.......##..." +
        "....##.....##...." +
        ".....##...##....." +
        "......##.##......" +
        ".......###......." +
        "................." +
        "................." +
        ".................";

    private static JavaScriptSerializer Serializer()
    {
        JavaScriptSerializer s = new JavaScriptSerializer();
        s.MaxJsonLength = 64 * 1024 * 1024;
        return s;
    }

    private static void WriteJson(object obj)
    {
        Console.WriteLine(Serializer().Serialize(obj));
    }

    private static string GetTitle(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string GetClass(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static HashSet<uint> ResolvePids(string namesSpec)
    {
        HashSet<uint> pids = new HashSet<uint>();
        string[] names = (string.IsNullOrWhiteSpace(namesSpec) ? "Weixin" : namesSpec)
            .Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string raw in names)
        {
            string name = raw.Trim();
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                name = name.Substring(0, name.Length - 4);
            if (name.Length == 0) continue;
            try
            {
                Process[] procs = Process.GetProcessesByName(name);
                foreach (Process p in procs)
                {
                    pids.Add((uint)p.Id);
                    p.Dispose();
                }
            }
            catch { }
        }
        return pids;
    }

    private static Point ToVirtualDesktopNormalized(int x, int y)
    {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        int nx = (int)Math.Round(((x - vx) * 65535.0) / Math.Max(1, vw - 1));
        int ny = (int)Math.Round(((y - vy) * 65535.0) / Math.Max(1, vh - 1));
        return new Point(nx, ny);
    }

    private static void SendMouse(uint flags, int x, int y, uint mouseData)
    {
        Point norm = ToVirtualDesktopNormalized(x, y);
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi.dx = norm.X;
        inputs[0].U.mi.dy = norm.Y;
        inputs[0].U.mi.mouseData = mouseData;
        inputs[0].U.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendKey(ushort vk, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = vk;
        inputs[0].U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendUnicodeChar(char ch)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = 0;
        inputs[0].U.ki.wScan = (ushort)ch;
        inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = 0;
        inputs[1].U.ki.wScan = (ushort)ch;
        inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendCtrlCombo(ushort vk)
    {
        SendKey(VK_CONTROL, false);
        Thread.Sleep(Rng.Next(24, 48));
        SendKey(vk, false);
        Thread.Sleep(Rng.Next(45, 95));
        SendKey(vk, true);
        Thread.Sleep(Rng.Next(22, 45));
        SendKey(VK_CONTROL, true);
    }

    private static void CurveMove(int startX, int startY, int endX, int endY, int steps, int minSleepMs, int maxSleepMs)
    {
        double dx = endX - startX;
        double dy = endY - startY;
        double dist = Math.Sqrt(dx * dx + dy * dy);
        if (dist < 4.0 || steps <= 1)
        {
            SendMouse(MOUSEEVENTF_MOVE, endX, endY, 0);
            return;
        }
        double nx = -dy / dist;
        double ny = dx / dist;
        double arc = (Rng.NextDouble() * 0.28 - 0.14) * dist;
        double c1x = startX + dx * 0.30 + nx * arc;
        double c1y = startY + dy * 0.30 + ny * arc;
        double c2x = startX + dx * 0.72 + nx * arc * 0.55;
        double c2y = startY + dy * 0.72 + ny * arc * 0.55;

        for (int i = 1; i <= steps; i++)
        {
            double u = i / (double)steps;
            double t = u * u * u * (10.0 + u * (-15.0 + 6.0 * u));
            double mt = 1.0 - t;
            double px = mt * mt * mt * startX + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * endX;
            double py = mt * mt * mt * startY + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * endY;
            if (i < steps)
            {
                px += Rng.NextDouble() * 1.6 - 0.8;
                py += Rng.NextDouble() * 1.6 - 0.8;
            }
            SendMouse(MOUSEEVENTF_MOVE, (int)Math.Round(px), (int)Math.Round(py), 0);
            Thread.Sleep(Rng.Next(minSleepMs, maxSleepMs + 1));
        }
    }

    private static void MoveMouseHuman(int targetX, int targetY)
    {
        POINT cur;
        if (!GetCursorPos(out cur))
        {
            SendMouse(MOUSEEVENTF_MOVE, targetX, targetY, 0);
            return;
        }
        double dist = Math.Sqrt((targetX - cur.X) * (double)(targetX - cur.X) + (targetY - cur.Y) * (double)(targetY - cur.Y));
        int steps = Math.Max(6, Math.Min(22, (int)(dist / 36.0)));
        CurveMove(cur.X, cur.Y, targetX, targetY, steps, 7, 16);
    }

    private static void LeftClick(int x, int y)
    {
        MoveMouseHuman(x, y);
        Thread.Sleep(Rng.Next(45, 95));
        SendMouse(MOUSEEVENTF_LEFTDOWN, x, y, 0);
        Thread.Sleep(Rng.Next(58, 128));
        SendMouse(MOUSEEVENTF_LEFTUP, x, y, 0);
    }

    private static void DoubleClick(int x, int y)
    {
        LeftClick(x, y);
        Thread.Sleep(70);
        SendMouse(MOUSEEVENTF_LEFTDOWN, x, y, 0);
        Thread.Sleep(35);
        SendMouse(MOUSEEVENTF_LEFTUP, x, y, 0);
    }

    private static bool ActivateWindow(IntPtr hWnd)
    {
        if (!IsWindow(hWnd)) return false;
        if (IsIconic(hWnd))
        {
            ShowWindow(hWnd, SW_RESTORE);
            Thread.Sleep(150);
        }
        IntPtr fg = GetForegroundWindow();
        if (fg == hWnd) return true;

        uint fgPid;
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
        uint curThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != 0 && fgThread != curThread)
        {
            attached = AttachThreadInput(curThread, fgThread, true);
        }
        try
        {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attached) AttachThreadInput(curThread, fgThread, false);
        }
        Thread.Sleep(160);
        return GetForegroundWindow() == hWnd;
    }

    private static bool VerifyWindowGuard(IntPtr hWnd, string expectedTitle, int x, int y, int width, int height)
    {
        if (!IsWindow(hWnd) || !IsWindowVisible(hWnd) || IsIconic(hWnd)) return false;
        if (GetForegroundWindow() != hWnd) return false;
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return false;
        if (Math.Abs(r.Left - x) > 2 || Math.Abs(r.Top - y) > 2
            || Math.Abs((r.Right - r.Left) - width) > 2 || Math.Abs((r.Bottom - r.Top) - height) > 2)
        {
            return false;
        }
        if (!string.IsNullOrEmpty(expectedTitle))
        {
            string liveTitle = GetTitle(hWnd).Trim();
            if (!string.Equals(liveTitle, expectedTitle.Trim(), StringComparison.Ordinal))
                return false;
        }
        return true;
    }

    private static void CmdWindows(string[] args)
    {
        string spec = args.Length > 1 ? args[1] : "Weixin";
        HashSet<uint> pids = ResolvePids(spec);
        IntPtr fg = GetForegroundWindow();
        List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();

        if (pids.Count > 0)
        {
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (!pids.Contains(pid)) return true;
                if (!IsWindowVisible(hWnd)) return true;

                RECT r;
                if (!GetWindowRect(hWnd, out r)) return true;
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                bool iconic = IsIconic(hWnd);
                string title = GetTitle(hWnd);
                string cls = GetClass(hWnd);
                if (!iconic && (w < 320 || h < 240)) return true;
                if (cls.IndexOf("Shadow", StringComparison.OrdinalIgnoreCase) >= 0
                    || cls.IndexOf("ToolTip", StringComparison.OrdinalIgnoreCase) >= 0
                    || cls.IndexOf("Menu", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }

                uint affinity = 0;
                GetWindowDisplayAffinity(hWnd, out affinity);

                Dictionary<string, object> row = new Dictionary<string, object>();
                row["id"] = hWnd.ToInt64();
                row["pid"] = pid;
                row["title"] = title;
                row["className"] = cls;
                row["x"] = r.Left;
                row["y"] = r.Top;
                row["width"] = w;
                row["height"] = h;
                row["onscreen"] = !iconic && w >= 320 && h >= 240;
                row["sharing"] = affinity == 0 ? 1 : 0;
                row["frontmost"] = hWnd == fg;
                list.Add(row);
                return true;
            }, IntPtr.Zero);
        }

        Dictionary<string, object> res = new Dictionary<string, object>();
        res["running"] = pids.Count > 0;
        res["windows"] = list;
        WriteJson(res);
    }

    private static void CmdDisplay()
    {
        Screen primary = Screen.PrimaryScreen;
        Rectangle wa = primary != null ? primary.WorkingArea : new Rectangle(0, 0, 1920, 1080);
        Rectangle b = primary != null ? primary.Bounds : wa;
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["x"] = wa.X;
        res["y"] = wa.Y;
        res["width"] = wa.Width;
        res["height"] = wa.Height;
        res["boundsWidth"] = b.Width;
        res["boundsHeight"] = b.Height;
        WriteJson(res);
    }

    private static void CmdFront(string[] args)
    {
        string spec = args.Length > 1 ? args[1] : "Weixin";
        HashSet<uint> pids = ResolvePids(spec);
        IntPtr fg = GetForegroundWindow();
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (fg == IntPtr.Zero)
        {
            res["isWeChat"] = false;
            res["id"] = 0;
            res["title"] = "";
            WriteJson(res);
            return;
        }
        uint pid;
        GetWindowThreadProcessId(fg, out pid);
        RECT r;
        GetWindowRect(fg, out r);
        res["isWeChat"] = pids.Contains(pid);
        res["id"] = fg.ToInt64();
        res["title"] = GetTitle(fg);
        res["x"] = r.Left;
        res["y"] = r.Top;
        res["width"] = r.Right - r.Left;
        res["height"] = r.Bottom - r.Top;
        WriteJson(res);
    }

    private static void CmdActivate(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        bool ok = ActivateWindow(hWnd);
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["ok"] = ok;
        res["frontId"] = GetForegroundWindow().ToInt64();
        WriteJson(res);
    }

    private static void CmdMove(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        int x = int.Parse(args[2], CultureInfo.InvariantCulture);
        int y = int.Parse(args[3], CultureInfo.InvariantCulture);
        int w = int.Parse(args[4], CultureInfo.InvariantCulture);
        int h = int.Parse(args[5], CultureInfo.InvariantCulture);
        if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
        bool ok = MoveWindow(hWnd, x, y, w, h, true);
        Thread.Sleep(120);
        RECT r;
        GetWindowRect(hWnd, out r);
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["ok"] = ok;
        res["x"] = r.Left;
        res["y"] = r.Top;
        res["width"] = r.Right - r.Left;
        res["height"] = r.Bottom - r.Top;
        WriteJson(res);
    }

    private static void CmdClose(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        bool ok = PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["ok"] = ok;
        WriteJson(res);
    }

    private static void NudgeAccessibility(IntPtr hWnd)
    {
        IntPtr result;
        SendMessageTimeout(hWnd, WM_GETOBJECT, IntPtr.Zero, new IntPtr(-4), SMTO_ABORTIFHUNG, 150, out result);
    }

    private static void WalkUia(AutomationElement node, List<AutomationElement> acc, int maxNodes, int depth)
    {
        if (node == null || acc.Count >= maxNodes || depth > 18) return;
        acc.Add(node);
        AutomationElement child = null;
        try { child = TreeWalker.RawViewWalker.GetFirstChild(node); } catch { child = null; }
        while (child != null && acc.Count < maxNodes)
        {
            WalkUia(child, acc, maxNodes, depth + 1);
            try { child = TreeWalker.RawViewWalker.GetNextSibling(child); } catch { child = null; }
        }
    }

    private static void CmdUiaRead(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        bool detached = args.Length > 2 && args[2] == "1";
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (!IsWindow(hWnd))
        {
            res["available"] = false;
            res["title"] = "";
            res["messages"] = new object[0];
            WriteJson(res);
            return;
        }
        NudgeAccessibility(hWnd);
        RECT wr;
        GetWindowRect(hWnd, out wr);
        int winW = Math.Max(1, wr.Right - wr.Left);
        int winH = Math.Max(1, wr.Bottom - wr.Top);
        int chatLeft = detached ? wr.Left : wr.Left + (int)(winW * 0.28);
        int chatWidth = Math.Max(1, wr.Right - chatLeft);

        List<AutomationElement> nodes = new List<AutomationElement>();
        try
        {
            AutomationElement root = AutomationElement.FromHandle(hWnd);
            WalkUia(root, nodes, 700, 0);
        }
        catch
        {
            res["available"] = false;
            res["title"] = GetTitle(hWnd);
            res["messages"] = new object[0];
            WriteJson(res);
            return;
        }

        if (nodes.Count <= 5)
        {
            res["available"] = false;
            res["title"] = GetTitle(hWnd);
            res["messages"] = new object[0];
            WriteJson(res);
            return;
        }

        string headerTitle = "";
        List<Dictionary<string, object>> items = new List<Dictionary<string, object>>();

        foreach (AutomationElement el in nodes)
        {
            try
            {
                string name = (el.Current.Name ?? "").Trim();
                if (name.Length == 0) continue;
                string cls = el.Current.ClassName ?? "";
                ControlType ct = el.Current.ControlType;
                System.Windows.Rect br = el.Current.BoundingRectangle;
                if (double.IsInfinity(br.X) || double.IsNaN(br.X) || br.Width <= 0 || br.Height <= 0) continue;

                if (br.X >= chatLeft - 8 && br.Y >= wr.Top && br.Y < wr.Top + winH * 0.13 && headerTitle.Length == 0)
                {
                    if (ct == ControlType.Text && name.Length <= 60) headerTitle = name;
                }

                bool inChatArea = br.X >= chatLeft && br.Right <= wr.Right + 4
                    && br.Y >= wr.Top + Math.Max(42, winH * 0.10)
                    && br.Bottom <= wr.Top + winH * 0.86;
                if (!inChatArea) continue;

                bool isMessageNode = cls.IndexOf("ChatTextItemView", StringComparison.OrdinalIgnoreCase) >= 0
                    || cls.IndexOf("ChatItem", StringComparison.OrdinalIgnoreCase) >= 0
                    || ct == ControlType.ListItem
                    || ct == ControlType.Text;
                if (!isMessageNode) continue;

                Dictionary<string, object> row = new Dictionary<string, object>();
                row["text"] = name;
                row["cls"] = cls;
                row["ct"] = ct != null ? ct.ProgrammaticName : "";
                row["x"] = (br.X - chatLeft) / chatWidth;
                row["y"] = (br.Y - wr.Top) / (winH * 0.86);
                row["w"] = br.Width / chatWidth;
                row["h"] = br.Height / (winH * 0.86);
                items.Add(row);
            }
            catch { }
        }

        res["available"] = items.Count > 0;
        res["title"] = headerTitle.Length > 0 ? headerTitle : GetTitle(hWnd);
        res["items"] = items;
        WriteJson(res);
    }

    private static void CmdUiaGroups(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (!IsWindow(hWnd))
        {
            res["available"] = false;
            res["groups"] = new string[0];
            WriteJson(res);
            return;
        }
        NudgeAccessibility(hWnd);
        RECT wr;
        GetWindowRect(hWnd, out wr);
        int winW = Math.Max(1, wr.Right - wr.Left);
        int sidebarRight = wr.Left + (int)(winW * 0.34);

        List<AutomationElement> nodes = new List<AutomationElement>();
        try
        {
            WalkUia(AutomationElement.FromHandle(hWnd), nodes, 500, 0);
        }
        catch { }

        List<string> groups = new List<string>();
        foreach (AutomationElement el in nodes)
        {
            try
            {
                string name = (el.Current.Name ?? "").Trim();
                if (name.Length < 2 || name.Length > 50) continue;
                System.Windows.Rect br = el.Current.BoundingRectangle;
                if (double.IsInfinity(br.X) || br.Width <= 0 || br.X < wr.Left + 40 || br.X > sidebarRight) continue;
                ControlType ct = el.Current.ControlType;
                if (ct != ControlType.ListItem && ct != ControlType.Text) continue;
                string firstLine = name.Split('\n')[0].Trim();
                if (firstLine == "搜索" || firstLine == "通讯录" || firstLine == "聊天" || firstLine == "收藏") continue;
                if (!groups.Contains(firstLine)) groups.Add(firstLine);
            }
            catch { }
        }
        res["available"] = groups.Count > 0;
        res["groups"] = groups;
        WriteJson(res);
    }

    private static void CmdUiaOpen(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        string targetName = args[2].Trim();
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (!IsWindow(hWnd))
        {
            res["ok"] = false;
            WriteJson(res);
            return;
        }
        NudgeAccessibility(hWnd);
        RECT wr;
        GetWindowRect(hWnd, out wr);
        int sidebarRight = wr.Left + (int)(Math.Max(1, wr.Right - wr.Left) * 0.36);

        List<AutomationElement> nodes = new List<AutomationElement>();
        try { WalkUia(AutomationElement.FromHandle(hWnd), nodes, 500, 0); } catch { }

        AutomationElement matched = null;
        foreach (AutomationElement el in nodes)
        {
            try
            {
                string name = (el.Current.Name ?? "").Trim();
                if (name.Length == 0) continue;
                System.Windows.Rect br = el.Current.BoundingRectangle;
                if (double.IsInfinity(br.X) || br.Width <= 0 || br.X < wr.Left + 36 || br.X > sidebarRight) continue;
                string head = name.Split('\n')[0].Trim();
                if (string.Equals(head, targetName, StringComparison.OrdinalIgnoreCase)
                    || head.StartsWith(targetName, StringComparison.OrdinalIgnoreCase)
                    || (head.Length >= 6 && targetName.StartsWith(head, StringComparison.OrdinalIgnoreCase)))
                {
                    matched = el;
                    break;
                }
            }
            catch { }
        }

        if (matched == null)
        {
            res["ok"] = false;
            WriteJson(res);
            return;
        }

        System.Windows.Rect rect = matched.Current.BoundingRectangle;
        if (!ActivateWindow(hWnd))
        {
            res["ok"] = false;
            WriteJson(res);
            return;
        }
        int cx = (int)Math.Round(rect.X + Math.Min(rect.Width * 0.45, 90));
        int cy = (int)Math.Round(rect.Y + rect.Height * 0.5);
        DoubleClick(cx, cy);
        res["ok"] = true;
        WriteJson(res);
    }

    private static bool IsBitmapBlank(Bitmap bmp)
    {
        int stepX = Math.Max(1, bmp.Width / 24);
        int stepY = Math.Max(1, bmp.Height / 24);
        Color first = bmp.GetPixel(bmp.Width / 2, bmp.Height / 2);
        int varied = 0;
        for (int y = stepY; y < bmp.Height; y += stepY)
        {
            for (int x = stepX; x < bmp.Width; x += stepX)
            {
                Color c = bmp.GetPixel(x, y);
                if (Math.Abs(c.R - first.R) + Math.Abs(c.G - first.G) + Math.Abs(c.B - first.B) > 12)
                {
                    varied++;
                    if (varied >= 4) return false;
                }
            }
        }
        return true;
    }

    private static Bitmap CaptureWindowOrRect(IntPtr hWnd, int rx, int ry, int rw, int rh, out bool viaScreen)
    {
        viaScreen = false;
        if (hWnd != IntPtr.Zero && IsWindow(hWnd))
        {
            RECT wr;
            if (GetWindowRect(hWnd, out wr))
            {
                int w = Math.Max(1, wr.Right - wr.Left);
                int h = Math.Max(1, wr.Bottom - wr.Top);
                Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                Graphics g = Graphics.FromImage(bmp);
                IntPtr hdc = g.GetHdc();
                bool ok = PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT);
                g.ReleaseHdc(hdc);
                g.Dispose();
                if (ok && !IsBitmapBlank(bmp))
                {
                    if (rw > 0 && rh > 0 && (rx != 0 || ry != 0 || rw != w || rh != h))
                    {
                        Rectangle crop = Rectangle.Intersect(new Rectangle(rx, ry, rw, rh), new Rectangle(0, 0, w, h));
                        Bitmap cropped = bmp.Clone(crop, PixelFormat.Format32bppArgb);
                        bmp.Dispose();
                        return cropped;
                    }
                    return bmp;
                }
                bmp.Dispose();
                if (rw <= 0 || rh <= 0)
                {
                    rx = wr.Left;
                    ry = wr.Top;
                    rw = w;
                    rh = h;
                }
                else
                {
                    rx = wr.Left + rx;
                    ry = wr.Top + ry;
                }
            }
        }

        viaScreen = true;
        Bitmap screenBmp = new Bitmap(Math.Max(1, rw), Math.Max(1, rh), PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(screenBmp))
        {
            g.CopyFromScreen(rx, ry, 0, 0, new Size(Math.Max(1, rw), Math.Max(1, rh)), CopyPixelOperation.SourceCopy);
        }
        return screenBmp;
    }

    private static void CmdCapture(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        string outPath = args[2];
        int rx = args.Length > 6 ? int.Parse(args[3], CultureInfo.InvariantCulture) : 0;
        int ry = args.Length > 6 ? int.Parse(args[4], CultureInfo.InvariantCulture) : 0;
        int rw = args.Length > 6 ? int.Parse(args[5], CultureInfo.InvariantCulture) : 0;
        int rh = args.Length > 6 ? int.Parse(args[6], CultureInfo.InvariantCulture) : 0;
        int maxWidth = args.Length > 7 ? int.Parse(args[7], CultureInfo.InvariantCulture) : 0;

        bool viaScreen;
        using (Bitmap bmp = CaptureWindowOrRect(hWnd, rx, ry, rw, rh, out viaScreen))
        {
            bool blank = IsBitmapBlank(bmp);
            Bitmap output = bmp;
            if (maxWidth > 0 && bmp.Width > maxWidth)
            {
                int newH = Math.Max(1, (int)Math.Round(bmp.Height * (maxWidth / (double)bmp.Width)));
                output = new Bitmap(maxWidth, newH, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(output))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(bmp, 0, 0, maxWidth, newH);
                }
            }
            try
            {
                output.Save(outPath, ImageFormat.Png);
                Dictionary<string, object> res = new Dictionary<string, object>();
                res["ok"] = true;
                res["width"] = output.Width;
                res["height"] = output.Height;
                res["viaRegion"] = viaScreen;
                res["blank"] = blank;
                WriteJson(res);
            }
            finally
            {
                if (!object.ReferenceEquals(output, bmp)) output.Dispose();
            }
        }
    }

    private static void CmdClipboardGet()
    {
        string text = "";
        try
        {
            if (Clipboard.ContainsText()) text = Clipboard.GetText();
        }
        catch { }
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["text"] = text;
        WriteJson(res);
    }

    private static void CmdClipboardSetText()
    {
        string input = Console.In.ReadToEnd();
        bool ok = false;
        for (int attempt = 0; attempt < 3 && !ok; attempt++)
        {
            try
            {
                if (input.Length == 0) Clipboard.Clear();
                else Clipboard.SetText(input, TextDataFormat.UnicodeText);
                ok = true;
            }
            catch { Thread.Sleep(40); }
        }
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["ok"] = ok;
        WriteJson(res);
    }

    private static void CmdClipboardSetImage(string[] args)
    {
        string path = args[1];
        bool ok = false;
        using (Bitmap bmp = new Bitmap(path))
        {
            for (int attempt = 0; attempt < 3 && !ok; attempt++)
            {
                try
                {
                    Clipboard.SetImage(bmp);
                    ok = true;
                }
                catch { Thread.Sleep(50); }
            }
        }
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["ok"] = ok;
        WriteJson(res);
    }

    private static void CmdDragCopy(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        string expectedTitle = args[2];
        int wx = int.Parse(args[3], CultureInfo.InvariantCulture);
        int wy = int.Parse(args[4], CultureInfo.InvariantCulture);
        int ww = int.Parse(args[5], CultureInfo.InvariantCulture);
        int wh = int.Parse(args[6], CultureInfo.InvariantCulture);
        int x1 = int.Parse(args[7], CultureInfo.InvariantCulture);
        int y1 = int.Parse(args[8], CultureInfo.InvariantCulture);
        int x2 = int.Parse(args[9], CultureInfo.InvariantCulture);
        int y2 = int.Parse(args[10], CultureInfo.InvariantCulture);
        string mode = args.Length > 11 ? args[11] : "copy";

        Dictionary<string, object> res = new Dictionary<string, object>();
        if (!VerifyWindowGuard(hWnd, expectedTitle, wx, wy, ww, wh))
        {
            res["ok"] = false;
            res["error"] = "微信聊天窗口已移动或未置于前面，已取消拖选";
            WriteJson(res);
            return;
        }

        MoveMouseHuman(x1, y1);
        Thread.Sleep(Rng.Next(85, 155));
        SendMouse(MOUSEEVENTF_LEFTDOWN, x1, y1, 0);
        Thread.Sleep(Rng.Next(95, 165));
        int steps = Rng.Next(24, 35);
        CurveMove(x1, y1, x2, y2, steps, 14, 28);
        Thread.Sleep(Rng.Next(165, 275));
        SendMouse(MOUSEEVENTF_LEFTUP, x2, y2, 0);
        Thread.Sleep(Rng.Next(185, 295));

        string copied = "";
        if (mode == "copy")
        {
            uint prevSeq = GetClipboardSequenceNumber();
            SendCtrlCombo(VK_C);
            for (int i = 0; i < 16; i++)
            {
                Thread.Sleep(50);
                if (GetClipboardSequenceNumber() != prevSeq)
                {
                    try
                    {
                        if (Clipboard.ContainsText())
                        {
                            string t = Clipboard.GetText();
                            if (!string.IsNullOrEmpty(t)) { copied = t; break; }
                        }
                    }
                    catch { }
                }
            }
            // Exit WeChat multi-select toolbar so the composer box returns.
            SendKey(VK_ESCAPE, false);
            Thread.Sleep(35);
            SendKey(VK_ESCAPE, true);
            Thread.Sleep(120);
        }

        res["ok"] = true;
        res["text"] = copied;
        WriteJson(res);
    }

    private static void CmdComposerAction(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        string expectedTitle = args[2];
        int wx = int.Parse(args[3], CultureInfo.InvariantCulture);
        int wy = int.Parse(args[4], CultureInfo.InvariantCulture);
        int ww = int.Parse(args[5], CultureInfo.InvariantCulture);
        int wh = int.Parse(args[6], CultureInfo.InvariantCulture);
        string action = args[7];

        Dictionary<string, object> res = new Dictionary<string, object>();
        if (!VerifyWindowGuard(hWnd, expectedTitle, wx, wy, ww, wh))
        {
            res["ok"] = false;
            res["error"] = "微信窗口已切换或失去焦点，操作已取消";
            WriteJson(res);
            return;
        }

        if (action == "click")
        {
            int cx = int.Parse(args[8], CultureInfo.InvariantCulture);
            int cy = int.Parse(args[9], CultureInfo.InvariantCulture);
            LeftClick(cx, cy);
        }
        else if (action == "paste")
        {
            SendCtrlCombo(VK_V);
        }
        else if (action == "clear")
        {
            SendCtrlCombo(VK_A);
            Thread.Sleep(80);
            SendKey(VK_BACK, false);
            Thread.Sleep(30);
            SendKey(VK_BACK, true);
        }
        else if (action == "enter")
        {
            SendKey(VK_RETURN, false);
            Thread.Sleep(Rng.Next(42, 95));
            SendKey(VK_RETURN, true);
        }

        res["ok"] = true;
        WriteJson(res);
    }

    private static void CmdTypeChunks(string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        string expectedTitle = args[2];
        int wx = int.Parse(args[3], CultureInfo.InvariantCulture);
        int wy = int.Parse(args[4], CultureInfo.InvariantCulture);
        int ww = int.Parse(args[5], CultureInfo.InvariantCulture);
        int wh = int.Parse(args[6], CultureInfo.InvariantCulture);

        string stdinJson = Console.In.ReadToEnd();
        List<Dictionary<string, object>> chunks = Serializer().Deserialize<List<Dictionary<string, object>>>(stdinJson);
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (chunks == null)
        {
            res["ok"] = false;
            res["error"] = "输入分块格式无效";
            WriteJson(res);
            return;
        }

        foreach (Dictionary<string, object> chunk in chunks)
        {
            if (!VerifyWindowGuard(hWnd, expectedTitle, wx, wy, ww, wh))
            {
                res["ok"] = false;
                res["error"] = "微信窗口已切换或失去焦点，输入已中止";
                WriteJson(res);
                return;
            }
            string text = chunk.ContainsKey("text") ? Convert.ToString(chunk["text"]) : "";
            int delayMs = chunk.ContainsKey("delayMs") ? Convert.ToInt32(chunk["delayMs"], CultureInfo.InvariantCulture) : 120;
            for (int i = 0; i < text.Length; i++)
            {
                SendUnicodeChar(text[i]);
                if (i + 1 < text.Length) Thread.Sleep(Rng.Next(6, 19));
            }
            Thread.Sleep(Math.Max(25, delayMs));
        }
        res["ok"] = true;
        WriteJson(res);
    }

    // --------------------------------------------------------- Sticker Vision

    private sealed class Raster
    {
        public readonly int Width;
        public readonly int Height;
        public readonly byte[] Pixels; // RGBA order

        private Raster(int width, int height, byte[] pixels)
        {
            Width = width;
            Height = height;
            Pixels = pixels;
        }

        public static Raster Load(string path)
        {
            if (!File.Exists(path)) return null;
            using (Bitmap src = new Bitmap(path))
            {
                if (src.Width <= 0 || src.Height <= 0 || src.Width > 8192 || src.Height > 8192) return null;
                int w = src.Width;
                int h = src.Height;
                byte[] rgba = new byte[w * h * 4];
                BitmapData bd = src.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] raw = new byte[bd.Stride * h];
                    Marshal.Copy(bd.Scan0, raw, 0, raw.Length);
                    for (int y = 0; y < h; y++)
                    {
                        int rowOffset = y * bd.Stride;
                        int dstRow = y * w * 4;
                        for (int x = 0; x < w; x++)
                        {
                            int si = rowOffset + x * 4;
                            int di = dstRow + x * 4;
                            rgba[di] = raw[si + 2];     // R
                            rgba[di + 1] = raw[si + 1]; // G
                            rgba[di + 2] = raw[si];     // B
                            rgba[di + 3] = raw[si + 3]; // A
                        }
                    }
                }
                finally
                {
                    src.UnlockBits(bd);
                }
                return new Raster(w, h, rgba);
            }
        }

        public double[] Sample(double x, double y, double width, double height, int size)
        {
            if (x < 0 || y < 0 || x + width > Width || y + height > Height) return null;
            double[] values = new double[size * size * 3];
            int idx = 0;
            for (int row = 0; row < size; row++)
            {
                int py = (int)(y + (row + 0.5) * height / size);
                for (int col = 0; col < size; col++)
                {
                    int px = (int)(x + (col + 0.5) * width / size);
                    int pi = (py * Width + px) * 4;
                    values[idx++] = Pixels[pi];
                    values[idx++] = Pixels[pi + 1];
                    values[idx++] = Pixels[pi + 2];
                }
            }
            return values;
        }

        public string Thumbnail(int x, int y, int size)
        {
            if (x < 0 || y < 0 || x + size > Width || y + size > Height || size <= 0) return null;
            using (Bitmap crop = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                BitmapData bd = crop.LockBits(new Rectangle(0, 0, size, size), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] dst = new byte[bd.Stride * size];
                    for (int row = 0; row < size; row++)
                    {
                        int srcRow = ((y + row) * Width + x) * 4;
                        int dstRow = row * bd.Stride;
                        for (int col = 0; col < size; col++)
                        {
                            int si = srcRow + col * 4;
                            int di = dstRow + col * 4;
                            dst[di] = Pixels[si + 2];     // B
                            dst[di + 1] = Pixels[si + 1]; // G
                            dst[di + 2] = Pixels[si];     // R
                            dst[di + 3] = Pixels[si + 3]; // A
                        }
                    }
                    Marshal.Copy(dst, 0, bd.Scan0, dst.Length);
                }
                finally
                {
                    crop.UnlockBits(bd);
                }
                using (MemoryStream ms = new MemoryStream())
                {
                    crop.Save(ms, ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
            }
        }
    }

    private static string VisualKey(double[] sample)
    {
        byte[] bytes = new byte[sample.Length];
        for (int i = 0; i < sample.Length; i++)
        {
            int v = (int)Math.Round(sample[i]);
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            bytes[i] = (byte)v;
        }
        return Convert.ToBase64String(bytes);
    }

    private static void LocateIcon(Raster raster, double scaleX, double scaleY, string mask,
        int left, int right, int top, int bottom, double threshold)
    {
        List<bool> stencil = new List<bool>();
        double fg = 0;
        for (int i = 0; i < mask.Length; i++)
        {
            char ch = mask[i];
            if (char.IsWhiteSpace(ch)) continue;
            bool on = ch == '#';
            stencil.Add(on);
            if (on) fg += 1.0;
        }
        double total = stencil.Count;
        double bg = total - fg;

        int bestX = left, bestY = top;
        double bestScore = 0.0;
        List<double[]> hits = new List<double[]>();

        for (int y = top; y <= bottom; y++)
        {
            for (int x = left; x <= right; x++)
            {
                double[] sample = raster.Sample((x - 10) * scaleX, (y - 10) * scaleY, 20 * scaleX, 20 * scaleY, 17);
                if (sample == null) continue;
                double onSum = 0, offSum = 0, sq = 0;
                for (int i = 0; i < stencil.Count; i++)
                {
                    int p = i * 3;
                    double luma = (sample[p] + sample[p + 1] + sample[p + 2]) / 3.0;
                    if (stencil[i]) onSum += luma; else offSum += luma;
                    sq += luma * luma;
                }
                double mean = (onSum + offSum) / total;
                double variance = sq / total - mean * mean;
                if (variance < 64.0) continue;
                double value = Math.Abs(onSum / fg - offSum / bg) * Math.Sqrt(fg * bg) / (total * Math.Sqrt(variance));
                if (value >= threshold) hits.Add(new double[] { x, y, value });
                if (value > bestScore)
                {
                    bestScore = value;
                    bestX = x;
                    bestY = y;
                }
            }
        }

        bool duplicate = false;
        foreach (double[] hit in hits)
        {
            if (Math.Abs(hit[0] - bestX) + Math.Abs(hit[1] - bestY) >= 8 && hit[2] > bestScore - 0.08)
            {
                duplicate = true;
                break;
            }
        }

        Dictionary<string, object> res = new Dictionary<string, object>();
        if (bestScore < threshold || duplicate)
        {
            res["found"] = false;
        }
        else
        {
            res["found"] = true;
            res["x"] = bestX;
            res["y"] = bestY;
        }
        WriteJson(res);
    }

    private static int InkCount(double[] sample, double[] background)
    {
        int count = 0;
        for (int i = 0; i < sample.Length; i += 3)
        {
            if (Math.Abs(sample[i] - background[0]) > 36
                || Math.Abs(sample[i + 1] - background[1]) > 36
                || Math.Abs(sample[i + 2] - background[2]) > 36)
            {
                count++;
            }
        }
        return count;
    }

    private static List<Point> CellPositions(Raster raster, double scaleX, double scaleY, int heartX, int heartY)
    {
        List<Point> positions = new List<Point>();
        int left = heartX - 77;
        int top = heartY - 435;
        int bottom = heartY - 27;
        if (top < 0) return positions;
        double[] background = raster.Sample((left - 43) * scaleX, (heartY - 32) * scaleY, 1, 1, 1);
        if (background == null) return positions;

        int[] columns = new int[5];
        for (int c = 0; c < 5; c++) columns[c] = left + c * 88;

        List<int[]> bands = new List<int[]>();
        for (int y = top; y < bottom; y++)
        {
            bool marked = false;
            for (int c = 0; c < 5; c++)
            {
                double[] line = raster.Sample((columns[c] - 33) * scaleX, y * scaleY, 66 * scaleX, 1, 8);
                if (line != null && InkCount(line, background) >= 8)
                {
                    marked = true;
                    break;
                }
            }
            if (!marked) continue;
            if (bands.Count > 0 && y - bands[bands.Count - 1][1] < 14)
                bands[bands.Count - 1][1] = y;
            else
                bands.Add(new int[] { y, y });
        }

        int firstCenter = heartY - 386;
        foreach (int[] band in bands)
        {
            int span = band[1] - band[0];
            if (span < 20 || span > 84 || band[0] <= top + 2 || band[1] >= bottom - 3) continue;
            int center = (band[0] + band[1]) / 2;
            int aligned = firstCenter + (int)Math.Round((center - firstCenter) / 88.0) * 88;
            int rowY = Math.Abs(center - aligned) <= 8 ? aligned : center;
            for (int c = 0; c < 5; c++)
            {
                int colX = columns[c];
                double[] sample = raster.Sample((colX - 24) * scaleX, (rowY - 24) * scaleY, 48 * scaleX, 48 * scaleY, 9);
                if (sample != null && InkCount(sample, background) >= 8)
                {
                    positions.Add(new Point(colX, rowY));
                }
            }
        }
        return positions;
    }

    private static void ScanGrid(Raster raster, double scaleX, double scaleY, int heartX, int heartY)
    {
        List<Dictionary<string, object>> cells = new List<Dictionary<string, object>>();
        int side = (int)Math.Round(52 * scaleX);
        foreach (Point pt in CellPositions(raster, scaleX, scaleY, heartX, heartY))
        {
            string image = raster.Thumbnail((int)((pt.X - 26) * scaleX), (int)((pt.Y - 26) * scaleY), side);
            double[] sample = raster.Sample((pt.X - 26) * scaleX, (pt.Y - 26) * scaleY, 52 * scaleX, 52 * scaleY, 10);
            double[] detail = raster.Sample((pt.X - 26) * scaleX, (pt.Y - 26) * scaleY, 52 * scaleX, 52 * scaleY, 24);
            if (image == null || sample == null || detail == null) continue;
            int[] sig = new int[sample.Length];
            for (int i = 0; i < sample.Length; i++) sig[i] = (int)Math.Round(sample[i]);
            Dictionary<string, object> cell = new Dictionary<string, object>();
            cell["image"] = image;
            cell["signature"] = sig;
            cell["visual"] = VisualKey(detail);
            cell["x"] = pt.X;
            cell["y"] = pt.Y;
            cells.Add(cell);
        }
        Dictionary<string, object> res = new Dictionary<string, object>();
        res["cells"] = cells;
        WriteJson(res);
    }

    private static void LocateSticker(Raster raster, double scaleX, double scaleY, Raster reference, int heartX, int heartY)
    {
        const int size = 15;
        double[] template = reference.Sample(0, 0, reference.Width, reference.Height, size);
        Dictionary<string, object> res = new Dictionary<string, object>();
        if (template == null)
        {
            res["found"] = false;
            WriteJson(res);
            return;
        }

        List<double[]> scored = new List<double[]>();
        foreach (Point pt in CellPositions(raster, scaleX, scaleY, heartX, heartY))
        {
            double bestErr = double.PositiveInfinity;
            for (int oy = -5; oy <= 5; oy++)
            {
                for (int ox = -5; ox <= 5; ox++)
                {
                    double[] sample = raster.Sample((pt.X + ox - 26) * scaleX, (pt.Y + oy - 26) * scaleY, 52 * scaleX, 52 * scaleY, size);
                    if (sample == null) continue;
                    double sum = 0;
                    for (int i = 0; i < template.Length; i++) sum += Math.Abs(sample[i] - template[i]);
                    double err = sum / template.Length;
                    if (err < bestErr) bestErr = err;
                }
            }
            scored.Add(new double[] { pt.X, pt.Y, bestErr });
        }
        scored.Sort(delegate(double[] a, double[] b) { return a[2].CompareTo(b[2]); });
        double secondErr = scored.Count > 1 ? scored[1][2] : double.PositiveInfinity;
        if (scored.Count == 0 || scored[0][2] > 20.0 || secondErr - scored[0][2] < 10.0)
        {
            res["found"] = false;
        }
        else
        {
            res["found"] = true;
            res["x"] = (int)scored[0][0];
            res["y"] = (int)scored[0][1];
        }
        WriteJson(res);
    }

    private static void CmdStickerInteract(string mode, string[] args)
    {
        IntPtr hWnd = new IntPtr(long.Parse(args[1], CultureInfo.InvariantCulture));
        int wx = (int)Math.Round(double.Parse(args[2], CultureInfo.InvariantCulture));
        int wy = (int)Math.Round(double.Parse(args[3], CultureInfo.InvariantCulture));
        int ww = (int)Math.Round(double.Parse(args[4], CultureInfo.InvariantCulture));
        int wh = (int)Math.Round(double.Parse(args[5], CultureInfo.InvariantCulture));
        int clickX = (int)Math.Round(double.Parse(args[6], CultureInfo.InvariantCulture));
        int clickY = (int)Math.Round(double.Parse(args[7], CultureInfo.InvariantCulture));
        string title = args[8];

        Dictionary<string, object> res = new Dictionary<string, object>();
        Rectangle bounds = new Rectangle(wx, wy, ww, wh);
        if (!VerifyWindowGuard(hWnd, title, wx, wy, ww, wh) || !bounds.Contains(clickX, clickY))
        {
            res["acted"] = false;
            WriteJson(res);
            return;
        }

        uint targetPid;
        GetWindowThreadProcessId(hWnd, out targetPid);
        POINT pt = new POINT { X = clickX, Y = clickY };
        IntPtr hitWnd = WindowFromPoint(pt);
        if (hitWnd != IntPtr.Zero)
        {
            uint hitPid;
            GetWindowThreadProcessId(GetAncestor(hitWnd, GA_ROOT), out hitPid);
            if (hitPid != targetPid)
            {
                res["acted"] = false;
                WriteJson(res);
                return;
            }
        }

        if (mode == "scroll")
        {
            int delta = int.Parse(args[9], CultureInfo.InvariantCulture);
            SendMouse(MOUSEEVENTF_MOVE, clickX, clickY, 0);
            Thread.Sleep(25);
            SendMouse(MOUSEEVENTF_WHEEL, clickX, clickY, unchecked((uint)delta));
        }
        else
        {
            LeftClick(clickX, clickY);
        }
        res["acted"] = true;
        WriteJson(res);
    }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            SetProcessDPIAware();
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.InputEncoding = new UTF8Encoding(false);
            if (args.Length == 0) return 2;

            string mode = args[0];
            if (mode == "windows") { CmdWindows(args); return 0; }
            if (mode == "display") { CmdDisplay(); return 0; }
            if (mode == "front") { CmdFront(args); return 0; }
            if (mode == "activate") { CmdActivate(args); return 0; }
            if (mode == "move") { CmdMove(args); return 0; }
            if (mode == "close") { CmdClose(args); return 0; }
            if (mode == "uia-read") { CmdUiaRead(args); return 0; }
            if (mode == "uia-groups") { CmdUiaGroups(args); return 0; }
            if (mode == "uia-open") { CmdUiaOpen(args); return 0; }
            if (mode == "capture") { CmdCapture(args); return 0; }
            if (mode == "clipboard-get") { CmdClipboardGet(); return 0; }
            if (mode == "clipboard-set-text") { CmdClipboardSetText(); return 0; }
            if (mode == "clipboard-set-image") { CmdClipboardSetImage(args); return 0; }
            if (mode == "drag-copy") { CmdDragCopy(args); return 0; }
            if (mode == "composer-action") { CmdComposerAction(args); return 0; }
            if (mode == "type-chunks") { CmdTypeChunks(args); return 0; }

            if (mode == "fingerprints")
            {
                string manifestJson = File.ReadAllText(args[1], Encoding.UTF8);
                Dictionary<string, string> files = Serializer().Deserialize<Dictionary<string, string>>(manifestJson);
                Dictionary<string, string> keys = new Dictionary<string, string>();
                foreach (KeyValuePair<string, string> kv in files)
                {
                    Raster r = Raster.Load(kv.Value);
                    if (r == null) continue;
                    double[] detail = r.Sample(0, 0, r.Width, r.Height, 24);
                    if (detail != null) keys[kv.Key] = VisualKey(detail);
                }
                WriteJson(keys);
                return 0;
            }
            if (mode == "click" || mode == "scroll")
            {
                CmdStickerInteract(mode, args);
                return 0;
            }
            if (mode == "toolbar" || mode == "favorites" || mode == "sticker" || mode == "grid")
            {
                Raster raster = Raster.Load(args[1]);
                double width = double.Parse(args[2], CultureInfo.InvariantCulture);
                double height = double.Parse(args[3], CultureInfo.InvariantCulture);
                if (raster == null || width <= 0 || height <= 0) return 2;
                double scaleX = raster.Width / width;
                double scaleY = raster.Height / height;
                if (mode == "toolbar" || mode == "favorites")
                {
                    int left = int.Parse(args[4], CultureInfo.InvariantCulture);
                    int right = int.Parse(args[5], CultureInfo.InvariantCulture);
                    int top = int.Parse(args[6], CultureInfo.InvariantCulture);
                    int bottom = int.Parse(args[7], CultureInfo.InvariantCulture);
                    LocateIcon(raster, scaleX, scaleY, mode == "toolbar" ? SmileMask : HeartMask,
                        left, right, top, bottom, mode == "toolbar" ? 0.70 : 0.66);
                    return 0;
                }
                if (mode == "sticker")
                {
                    Raster reference = Raster.Load(args[4]);
                    if (reference == null) return 2;
                    int hx = int.Parse(args[5], CultureInfo.InvariantCulture);
                    int hy = int.Parse(args[6], CultureInfo.InvariantCulture);
                    LocateSticker(raster, scaleX, scaleY, reference, hx, hy);
                    return 0;
                }
                if (mode == "grid")
                {
                    int hx = int.Parse(args[4], CultureInfo.InvariantCulture);
                    int hy = int.Parse(args[5], CultureInfo.InvariantCulture);
                    ScanGrid(raster, scaleX, scaleY, hx, hy);
                    return 0;
                }
            }
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
