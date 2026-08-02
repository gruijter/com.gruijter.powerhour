---
name: homey-realtime-profiling
description: Real-time memory profiling and runtime performance analysis for Homey apps (on physical Homey Pro via --remote and locally in Docker container).
---

# Homey Real-Time Memory Profiling & Performance Analysis Guide

This guide documents how AI agents and developers can perform real-time memory profiling, heap leak detection, and performance analysis on Homey Pro applications (both on physical Homey hardware via `--remote` and locally inside a Docker container).

---

## 1. Important Constraints in Homey Environment

- **V8 Sandbox Restrictions**: Homey Pro runs apps inside a restricted V8 sandbox.
- **`process.memoryUsage()` Warning**: Calling Node.js standard `process.memoryUsage()` inside a Homey app will **crash the app** with:
  `Error: ENOENT: no such file or directory, uv_resident_set_memory`
  because libuv OS-level memory queries (`uv_resident_set_memory`) are blocked by the Homey sandbox.
- **Homey Pro RAM Limits**: Apps have a RAM limit of ~70-80 MB. Exceeding this limit causes an Out-Of-Memory (OOM) crash (`Memory Warning Limit Reached`).

---

## 2. Method 1: Sandbox-Safe V8 Heap Statistics Logger (Automated/Background Profiling)

To profile memory safely on both a physical Homey and in a Docker container without crashing the app, use Node.js built-in **`require('v8').getHeapStatistics()`**. This queries pure V8 JavaScript heap statistics without querying libuv/OS.

### Implementation in `app.js`:

```javascript
// In app.js
const v8 = require('v8');

class MyApp extends Homey.App {
  async onInit() {
    // Temporary V8 Heap Profiler
    this.memProfileHistory = [];
    this.memInterval = this.homey.setInterval(() => {
      const heap = v8.getHeapStatistics();
      const usedMB = Number((heap.used_heap_size / 1024 / 1024).toFixed(2));
      const totalMB = Number((heap.total_heap_size / 1024 / 1024).toFixed(2));
      const limitMB = Number((heap.heap_size_limit / 1024 / 1024).toFixed(2));
      const timeStr = new Date().toISOString();
      this.memProfileHistory.push({ time: timeStr, usedMB, totalMB });
      this.log(`[MEM_PROFILE] ${timeStr} | Used: ${usedMB} MB | Total: ${totalMB} MB | Limit: ${limitMB} MB | Samples: ${this.memProfileHistory.length}`);
    }, 60 * 1000); // 60s interval for long-term tests, or 5s for short tests

    // ... rest of onInit ...
  }

  async onUninit() {
    if (this.memInterval) this.homey.clearInterval(this.memInterval);
    // ... rest of onUninit ...
  }
}
```

### Execution Commands:

1. **Physical Homey Pro (`--remote`)**:
   ```bash
   homey app run --remote
   ```
2. **Local Docker Container**:
   ```bash
   homey app run
   ```

---

## 3. Method 2: Live V8 Inspector & Chrome DevTools (`chrome://inspect`)

For visual memory analysis, Heap Snapshots, and Allocation Timelines using Chrome DevTools:

### Step 1: Enable V8 Inspector in `app.js`

Add V8 inspector trigger to `app.js`:

```javascript
class MyApp extends Homey.App {
  async onInit() {
    if (process.env.DEBUG === '1') {
      // Opens V8 Debugger port 9222 on all network interfaces
      require('inspector').open(9222, '0.0.0.0', false);
    }
  }
}
```

### Step 2: Run the App

- **Physical Homey Pro**:
  ```bash
  DEBUG=1 homey app run --remote
  ```
- **Docker Container**:
  ```bash
  DEBUG=1 homey app run
  ```

### Step 3: Connect Chrome DevTools

1. Open Chrome on your desktop PC: `chrome://inspect/#devices`.
2. Click **Configure...** under *Target discovery network targets*.
3. Add the target:
   - For Physical Homey: `<homey-ip>:9222` (e.g. `10.0.0.67:9222`)
   - For Docker Container: `127.0.0.1:9222` or `localhost:9222`
4. Under *Remote Target*, locate `com.gruijter.powerhour` and click **Inspect**.
5. Go to the **Memory** tab in Chrome DevTools to perform:
   - **Heap Snapshot**: Inspect active object counts (Buffers, Arrays, Closures).
   - **Allocation instrumentation on timeline**: Real-time memory allocation graph.
   - **Allocation sampling**: Low-overhead heap profiling over long durations.

---

## 4. Guidelines for AI Agents

1. **Rule 1**: Never use `process.memoryUsage()` in Homey code — always use `require('v8').getHeapStatistics()`.
2. **Rule 2**: Use `homey app run --remote` when testing on a physical Homey, and `homey app run` when testing in a local container.
3. **Rule 3**: Always revert/clean up any temporary profiling code in `app.js` after completing memory tests.
