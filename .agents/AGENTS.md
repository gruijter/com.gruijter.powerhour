# Workspace Rules & Guidelines - Homey App Development

## Memory Profiling & Analysis Rules for Homey Apps

1. **V8 Heap Statistics Only**:
   - **DO NOT** use `process.memoryUsage()` in Homey apps. It crashes inside the Homey V8 sandbox (`ENOENT: no such file or directory, uv_resident_set_memory`).
   - **ALWAYS** use `require('v8').getHeapStatistics()` for automated text/log-based heap profiling.

2. **Real-time Memory Profiling Skill**:
   - Refer to [.agents/skills/homey-realtime-profiling/SKILL.md](file:///home/robin/HomeyDev/com.gruijter.powerhour/.agents/skills/homey-realtime-profiling/SKILL.md) for full instructions on running live V8 Inspector and Chrome DevTools (`chrome://inspect`) both on physical Homey Pro (`--remote`) and in Docker containers.

3. **Clean Up Profiler Code**:
   - Always revert temporary heap-logging intervals or inspector triggers before finalizing changes or submitting pull requests.
