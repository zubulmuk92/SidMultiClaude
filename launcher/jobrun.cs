// jobrun.exe <exe> <args...> : runs the command inside a NEW Windows Job Object (KILL_ON_JOB_CLOSE, no breakaway allowed),
// with inherited stdio handles (no relaying). When jobrun dies for any reason (exit, TerminateProcess, parent job kill),
// its job handle closes and every process still in the job dies: the child AND descendants started through bash.
// C# 5 (csc from .NET Framework 4.8). Probe for SidMultiClaude (robustness proposal).
using System;
using System.Runtime.InteropServices;
using System.Text;

static class JobRun {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize,
    dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd,
    IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  const int JobObjectExtendedLimitInformation = 9;
  const uint KILL_ON_JOB_CLOSE = 0x2000;

  static string Tail(string cl) {        // the raw command line minus our own argv[0], quoting preserved byte for byte
    int i = 0;
    if (cl.Length > 0 && cl[0] == '"') { i = cl.IndexOf('"', 1); i = i < 0 ? cl.Length : i + 1; }
    else { while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++; }
    while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
    return cl.Substring(i);
  }

  static int Main() {
    string rest = Tail(Environment.CommandLine);
    if (rest.Length == 0) { Console.Error.WriteLine("usage: jobrun <exe> [args]"); return 2; }
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    EXT_LIMIT info = new EXT_LIMIT();
    info.Basic.LimitFlags = KILL_ON_JOB_CLOSE;            // NO BREAKAWAY_OK, NO SILENT_BREAKAWAY_OK
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(EXT_LIMIT)))) {
      Console.Error.WriteLine("jobrun: SetInformationJobObject failed " + Marshal.GetLastWin32Error()); return 3; }
    // Put ourselves in the job first (nested under the parent's libuv job on Win8+): every child we create starts inside it.
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
      Console.Error.WriteLine("jobrun: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error()); return 4; }
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcess(null, new StringBuilder(rest), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("jobrun: CreateProcess failed " + Marshal.GetLastWin32Error()); return 5; }
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;                                     // our exit closes the job handle: leftovers in the job die now
  }
}
