# agent-index on Windows: prerequisites and a quick check

**Maintained by:** agent-index
**Last Updated:** 2026-11-18

---

## About This Document

One page an org admin can send to Windows members. It covers what Windows needs before agent-index can run, how to run the Claude session, a quick check, and what to do when agent-index can't reach the computer. Written for bug `20261118-68dff8bf-143550-c1a2`. This copy ships with core 3.31.1; core 4.x carries the same page.

**What's verified.** The Windows build and feature settings are from one verified setup (2026-11-17), which published a full collection update this way. Everything else is marked *not yet verified* where it appears.

## When to use this guide

You don't need to go through this every time you use agent-index.

- **Once, when you first set up agent-index on a Windows computer:** "Before you start" and "How to run your Claude session". Again only if you get a new computer, or your Windows setup changes.
- **Optionally, at the start of a session:** the "Quick check", for example right after setup, or if something seems off.
- **Only when something goes wrong:** "If agent-index can't reach your computer".

## Why this matters

agent-index does its work on **your own computer**. When you use it from Claude, its tools run in a small Linux workspace (a "sandbox") on your Windows computer, and your agent-index sign-in stays on the computer. If that workspace can't run, agent-index can't work in the session, and you should stop and fix the setup (below). Never copy your sign-in anywhere else.

## Before you start

**Windows version**
- Windows 11. The verified build is **26200.9911**.
- In September 2026, a Windows update (**KB5124008**) broke the local sandbox. Microsoft fixed it in **KB5129195**. Make sure your updates are current: Settings → Windows Update.
- To see your build number, press Windows+R, type `winver` and press Enter.

**Windows features** (Start → type "Turn Windows features on or off")

| Feature | Setting |
|---|---|
| Virtual Machine Platform | **On** (required) |
| Windows Subsystem for Linux | **On** (required) |
| Windows Hypervisor Platform | Not needed (works on or off) |
| Hyper-V | Not needed (verified working when off) |

Turning a feature on asks you to restart Windows.

## How to run your Claude session

Your Claude session can run in the cloud, but it has to be **linked to this computer, with your Agent-Index folder connected**. Then agent-index's tools run in the sandbox on your computer, and your sign-in never leaves it.

## Quick check before working

*Not yet verified on Windows.* At the start of a session, ask Claude: **"check my agent-index connection"**. Claude runs agent-index's status check on your computer:

```
bash mcp-servers/filesystem/aifs-exec.sh aifs_auth_status
```

- **It reports that you're signed in:** you're ready.
- **It reports that you're not signed in:** say "fix my connection" (`@ai:member-bootstrap`) to sign in again on this computer.
- **It can't run at all** (no shell, or the command isn't found): agent-index can't reach your computer in this session. See below.

## If agent-index can't reach your computer

*These steps are not yet verified on a Windows machine that hit the problem.*

1. **Stop.** Don't run agent-index tasks in this session.
2. **Link the session to this computer and connect your Agent-Index folder,** then start a new session. Or:
3. **Use the Code tab** in Claude desktop, which reaches your local files differently and keeps working.
4. If neither works, tell your org admin, including your Windows build number and which features are on.

**Never accept an offer to copy your sign-in.** If Claude ever offers to copy or move your agent-index sign-in (`.agent-index/credentials/`) somewhere else "to finish the job", say no and tell your admin. Your sign-in must stay on your computer: a copy elsewhere can expose access to your company's files, and can sign you out on your own computer.

## For org admins

- **One verified setup (2026-11-17):** Windows 11 26200.9911; Virtual Machine Platform and WSL on; Hypervisor Platform and Hyper-V off; cloud Cowork session linked to the computer with the Agent-Index folder connected.
- **Known unresolved case:** a setup on the same build, with those features plus Hypervisor Platform on, couldn't run the executor. Features and build don't explain it. The likely causes are a session that wasn't linked, or a local sandbox that didn't start.
- **Workaround:** the Code tab.
