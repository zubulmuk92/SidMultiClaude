// launcher/SidMultiClaude.cs — GUI-subsystem launcher + supervisor (SPEC §0.1, §2.9 C8, platform §5.3).
// Built by scripts/install.ps1 with the Windows csc.exe (C# 5): csc /target:winexe /win32icon:assets\app.ico.
// Usage (written into the shortcut by install.ps1):  SidMultiClaude.exe "<node.exe>" "<app>\src\server\main.ts" [extra args]
// 1. If the server's pipe \\.\pipe\SidMultiClaude-<user> answers, the server opens a window: exit 0 (S18: one verb, no data).
// 2. Otherwise start `node main.ts --open --supervised` hidden (CreateNoWindow, no shell) and supervise it:
//    exit 0 = stop · 75 = restart requested · anything else = crash → restart after 0.5 / 2 / 5 s, at most 3 restarts in
//    60 s; then a MessageBox (or exit code 3 when SMC_LAUNCHER_NOBOX=1, for tests). Restarts never pass --open: the window
//    survives a server crash and reconnects with its device token. The launcher never builds a URL (T6).
// Test hooks: SMC_PIPE overrides the pipe name (same rule as src/server/platform/win.ts).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const int ExitStop = 0;
    const int ExitRestart = 75;
    const int MaxRestarts = 3;
    static readonly TimeSpan Window = TimeSpan.FromSeconds(60);
    static readonly int[] BackoffMs = { 500, 2000, 5000 };

    static string PipeName()
    {
        string over = Environment.GetEnvironmentVariable("SMC_PIPE");
        if (!string.IsNullOrEmpty(over)) return Regex.Replace(over, @"[^A-Za-z0-9_.-]", "_");
        return "SidMultiClaude-" + Regex.Replace(Environment.UserName, @"[^A-Za-z0-9_.-]", "_");
    }

    /// <summary>True when a running server answered "ok" on the pipe (it then opens a window itself).</summary>
    static bool HandOff()
    {
        try
        {
            using (var c = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut))
            {
                c.Connect(500);
                var buf = new byte[16];
                int n = c.Read(buf, 0, buf.Length);
                return n >= 2 && Encoding.ASCII.GetString(buf, 0, n).StartsWith("ok");
            }
        }
        catch (Exception) { return false; }
    }

    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char ch in a)
        {
            if (ch == '\\') { bs++; continue; }
            if (ch == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
            sb.Append('\\', bs); bs = 0; sb.Append(ch);
        }
        sb.Append('\\', bs * 2);
        return sb.Append('"').ToString();
    }

    static int RunServer(string node, string main, List<string> extra, bool open)
    {
        var args = new List<string> { main };
        args.AddRange(extra);
        if (open) args.Add("--open");
        args.Add("--supervised");
        var parts = new List<string>();
        foreach (var a in args) parts.Add(Quote(a));
        var psi = new ProcessStartInfo(node, string.Join(" ", parts.ToArray()))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(main))) ?? Environment.CurrentDirectory,   // <app>\src\server\main.ts → <app>
        };
        using (var p = Process.Start(psi))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    [STAThread]
    static int Main(string[] argv)
    {
        bool noBox = Environment.GetEnvironmentVariable("SMC_LAUNCHER_NOBOX") == "1";
        if (argv.Length < 2 || !File.Exists(argv[0]) || !File.Exists(argv[1]))
        {
            if (!noBox) MessageBox.Show("Raccourci invalide : relancez l'installation (npm run install-app).", "SidMultiClaude", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }
        if (HandOff()) return ExitStop;
        var extra = new List<string>();
        for (int i = 2; i < argv.Length; i++) extra.Add(argv[i]);
        var restarts = new List<DateTime>();
        bool open = true;
        while (true)
        {
            int code;
            try { code = RunServer(argv[0], argv[1], extra, open); }
            catch (Exception e)
            {
                if (!noBox) MessageBox.Show("Impossible de démarrer le serveur : " + e.Message, "SidMultiClaude", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }
            open = false;
            if (code == ExitStop) return ExitStop;
            DateTime now = DateTime.UtcNow;
            restarts.RemoveAll(t => now - t > Window);
            if (code != ExitRestart)
            {
                if (restarts.Count >= MaxRestarts)
                {
                    if (!noBox) MessageBox.Show("Le serveur SidMultiClaude s'est arrêté plusieurs fois de suite (code " + code + ").\nConsultez les journaux dans %LOCALAPPDATA%\\SidMultiClaude\\logs puis relancez l'application.", "SidMultiClaude", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 3;
                }
                Thread.Sleep(BackoffMs[Math.Min(restarts.Count, BackoffMs.Length - 1)]);
                restarts.Add(DateTime.UtcNow);
            }
        }
    }
}
