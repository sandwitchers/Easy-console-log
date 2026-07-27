// ============================================================
// Easy Console Log — SillyTavern Extension (v6)
// ============================================================
// NEW IN v6 (inspired by TauriTavern-Creator-Extension research):
// - NUMERIC ID + epoch timestampMs per log entry (stable keys)
// - DEDUPLICATED toast notifications (repeatCount pattern)
// - MULTI-FIELD SEARCH: message + level + source
// - STACK TRACE CAPTURE: Error objects get stack field
// - PROPER LIFECYCLE: cleanup on unload (remove listeners, restore console)
// - BETTER ARGS SERIALIZATION: Error objects, circular refs, depth limit
// - HIGHER CAPACITY: 500 max entries, 200 rendered DOM nodes
// - TARGET FIELD: origin context (e.g., "console.warn", "SSE.open")
// - MORE SSE EVENTS: added streaming, persona, world info events
//
// CRITICAL SAFETY MEASURES (carried from v5):
// 1. Only import what we ACTUALLY USE — unused imports crash ST
// 2. Console interception DELAYED until ST finishes loading
// 3. Every operation wrapped in try/catch to prevent ST hangs
// 4. Anti-recursion guard on addLog (isInsideAddLog flag)
// 5. Overlay visibility uses CLASS TOGGLE (.ecl-hidden)
// 6. Toggle buttons defensively re-ensured visible after render
// 7. Backend capture is SAFE — only monitors, never intercepts
//    fetch/XHR which would break ST's API functionality
// ============================================================

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "Easy-console-log";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ── Constants ──
const MAX_RENDERED_ENTRIES = 200;    // Max DOM nodes rendered (was 100)
const RENDER_DEBOUNCE_MS = 200;      // Batch rapid log arrivals into 1 render
const TOAST_DEDUP_WINDOW_MS = 3000;  // Dedup toast within 3s window
const MAX_OBJECT_DEPTH = 3;          // JSON serialization depth limit

// ── State ──
const defaultSettings = {
    enabled: true,
    captureBrowserConsole: true,
    captureBackendEvents: true,
    showNotifications: true,
    maxEntries: 500,          // Was 200 — now matches TauriTavern's cap
    activeSource: "frontend",
    activeFilter: "ALL",
};

let logs = [];
let logIdCounter = 0;            // Unique numeric ID per entry (TauriTavern pattern)
let originalConsole = {};
let isConsoleIntercepted = false;
let isBackendIntercepted = false;
let isMonitorOpen = false;
let toastTimeout = null;
let isInsideAddLog = false;
let renderDebounceTimer = null;
let pendingRenderType = "none"; // "full" | "incremental"
let lastRenderedLogIndex = -1;
let toastDedupMap = new Map();   // key → { count, lastShownMs } for dedup
let backendCleanupFns = [];      // Functions to call on unload for cleanup

// ── Initialize ──
jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings2").append(settingsHtml);

        const monitorHtml = await $.get(`${extensionFolderPath}/monitor.html`);
        $("body").append(monitorHtml);

        initSettings();
        bindEvents();

        waitForSillyTavernReady().then(() => {
            const settings = extension_settings[extensionName];
            if (settings.captureBrowserConsole) interceptConsole();
            if (settings.captureBackendEvents) interceptBackend();
        });

        // Register cleanup on page unload
        window.addEventListener("beforeunload", cleanupOnUnload);

    } catch (error) {
        if (originalConsole.error) {
            originalConsole.error(`[${extensionName}] Failed to load:`, error);
        } else {
            console.error(`[${extensionName}] Failed to load:`, error);
        }
    }
});

// ── Wait for SillyTavern to finish loading ──
function waitForSillyTavernReady() {
    return new Promise((resolve) => {
        let resolved = false;
        const doResolve = () => {
            if (resolved) return;
            resolved = true;
            resolve();
        };

        if (typeof eventSource !== "undefined" && eventSource.addEventListener) {
            eventSource.addEventListener("app_ready", doResolve, { once: true });
        }

        const checkInterval = setInterval(() => {
            try {
                if (typeof getContext === "function" || resolved) {
                    clearInterval(checkInterval);
                    doResolve();
                }
            } catch (e) { /* not ready yet */ }
        }, 500);

        setTimeout(() => {
            clearInterval(checkInterval);
            doResolve();
        }, 8000);
    });
}

// ── Lifecycle Cleanup ──
// Properly remove event listeners and restore console on unload.
// Prevents memory leaks from orphaned subscriptions (TauriTavern pattern).
function cleanupOnUnload() {
    try {
        // Restore original console methods
        restoreConsole();

        // Remove backend event listeners
        backendCleanupFns.forEach(fn => {
            try { fn(); } catch (e) { /* already gone */ }
        });
        backendCleanupFns = [];
        isBackendIntercepted = false;

        // Clear timers
        if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
        if (toastTimeout) clearTimeout(toastTimeout);

        // Clear state
        logs = [];
        logIdCounter = 0;
        toastDedupMap.clear();
    } catch (e) { /* non-critical on unload */ }
}

// ── Settings ──
function initSettings() {
    try {
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        if (Object.keys(extension_settings[extensionName]).length === 0) {
            Object.assign(extension_settings[extensionName], defaultSettings);
        }

        const settings = extension_settings[extensionName];

        const captureCheckbox = document.getElementById("ecl_capture_checkbox");
        if (captureCheckbox) captureCheckbox.checked = settings.captureBrowserConsole;

        const toggleButtons = document.querySelectorAll(".ecl-toggle-btn");
        toggleButtons.forEach(btn => btn.classList.remove("ecl-toggle-active"));
        const activeSourceBtn = document.querySelector(`.ecl-toggle-btn[data-source="${settings.activeSource}"]`);
        if (activeSourceBtn) activeSourceBtn.classList.add("ecl-toggle-active");

        const filterPills = document.querySelectorAll(".ecl-filter-pill");
        filterPills.forEach(pill => pill.classList.remove("ecl-filter-active"));
        const activeFilterBtn = document.querySelector(`.ecl-filter-pill[data-level="${settings.activeFilter}"]`);
        if (activeFilterBtn) activeFilterBtn.classList.add("ecl-filter-active");
    } catch (e) {
        console.error(`[${extensionName}] initSettings error:`, e);
    }
}

function saveSetting(key, value) {
    try {
        extension_settings[extensionName][key] = value;
        saveSettingsDebounced();
    } catch (e) {
        console.error(`[${extensionName}] saveSetting error:`, e);
    }
}

// ── Event Binding ──
function bindEvents() {
    try {
        $("#easy_console_log_open_btn").on("click", openMonitor);
        $("#ecl_close_btn").on("click", closeMonitor);
        $(".ecl-overlay-backdrop").on("click", closeMonitor);

        $(".ecl-toggle-btn").on("click", function () {
            $(".ecl-toggle-btn").removeClass("ecl-toggle-active");
            $(this).addClass("ecl-toggle-active");
            saveSetting("activeSource", $(this).data("source"));
            ensureToggleVisible();
            scheduleFullRender();
        });

        $("#ecl_capture_checkbox").on("change", function () {
            const checked = $(this).prop("checked");
            saveSetting("captureBrowserConsole", checked);
            if (checked) interceptConsole();
            else restoreConsole();
        });

        let searchDebounce = null;
        $("#ecl_search_input").on("input", function () {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                ensureToggleVisible();
                scheduleFullRender();
            }, 150);
        });

        $("#ecl_copy_btn").on("click", copyVisibleLogs);
        $("#ecl_clear_btn").on("click", clearLogs);

        $(".ecl-filter-pill").on("click", function () {
            $(".ecl-filter-pill").removeClass("ecl-filter-active");
            $(this).addClass("ecl-filter-active");
            saveSetting("activeFilter", $(this).data("level"));
            ensureToggleVisible();
            scheduleFullRender();
        });
    } catch (e) {
        console.error(`[${extensionName}] bindEvents error:`, e);
    }
}

// ── Monitor Open / Close ──
function openMonitor() {
    isMonitorOpen = true;
    const overlay = document.getElementById("easy-console-log-monitor-overlay");
    if (overlay) {
        overlay.classList.remove("ecl-hidden");
        overlay.style.removeProperty("display");
    }
    ensureToggleVisible();
    lastRenderedLogIndex = -1;
    scheduleFullRender();
}

function closeMonitor() {
    isMonitorOpen = false;
    const overlay = document.getElementById("easy-console-log-monitor-overlay");
    if (overlay) {
        overlay.classList.add("ecl-hidden");
        overlay.style.removeProperty("display");
    }
}

// ── Defensive Toggle Visibility ──
function ensureToggleVisible() {
    try {
        const overlay = document.getElementById("easy-console-log-monitor-overlay");
        if (!overlay || overlay.classList.contains("ecl-hidden")) return;

        const elems = [
            overlay.querySelector(".ecl-meta-row"),
            overlay.querySelector(".ecl-toggle-group"),
        ];
        elems.forEach(el => {
            if (el) {
                el.style.removeProperty("display");
                el.style.removeProperty("visibility");
                el.style.removeProperty("opacity");
                el.style.removeProperty("height");
                el.style.removeProperty("min-height");
                el.style.removeProperty("max-height");
            }
        });

        overlay.querySelectorAll(".ecl-toggle-btn").forEach(btn => {
            btn.style.removeProperty("display");
            btn.style.removeProperty("visibility");
            btn.style.removeProperty("opacity");
        });
    } catch (e) { /* non-critical */ }
}

// ============================================================
// FRONTEND: Console Interception (with stack trace capture)
// ============================================================
function interceptConsole() {
    if (isConsoleIntercepted) return;
    try {
        originalConsole.log   = console.log.bind(console);
        originalConsole.info  = console.info.bind(console);
        originalConsole.warn  = console.warn.bind(console);
        originalConsole.error = console.error.bind(console);
        originalConsole.debug = console.debug.bind(console);

        const settings = extension_settings[extensionName];

        console.log = function (...args) {
            try { originalConsole.log(...args); if (settings.captureBrowserConsole) safeAddLog("info", args, "frontend", "console.log"); }
            catch (e) { originalConsole.error(`[${extensionName}] console.log interceptor error:`, e); }
        };

        console.info = function (...args) {
            try { originalConsole.info(...args); if (settings.captureBrowserConsole) safeAddLog("info", args, "frontend", "console.info"); }
            catch (e) { originalConsole.error(`[${extensionName}] console.info interceptor error:`, e); }
        };

        console.warn = function (...args) {
            try {
                originalConsole.warn(...args);
                if (settings.captureBrowserConsole) {
                    const stack = extractStackFromArgs(args);
                    safeAddLog("warn", args, "frontend", "console.warn", stack);
                    if (settings.showNotifications) dedupedToast("warn", args);
                }
            }
            catch (e) { originalConsole.error(`[${extensionName}] console.warn interceptor error:`, e); }
        };

        console.error = function (...args) {
            try {
                originalConsole.error(...args);
                if (settings.captureBrowserConsole) {
                    const stack = extractStackFromArgs(args);
                    safeAddLog("error", args, "frontend", "console.error", stack);
                    if (settings.showNotifications) dedupedToast("error", args);
                }
            }
            catch (e) { originalConsole.error(`[${extensionName}] console.error interceptor error:`, e); }
        };

        console.debug = function (...args) {
            try { originalConsole.debug(...args); if (settings.captureBrowserConsole) safeAddLog("debug", args, "frontend", "console.debug"); }
            catch (e) { originalConsole.error(`[${extensionName}] console.debug interceptor error:`, e); }
        };

        isConsoleIntercepted = true;
    } catch (e) {
        console.error(`[${extensionName}] interceptConsole setup error:`, e);
    }
}

function restoreConsole() {
    if (!isConsoleIntercepted) return;
    try {
        if (originalConsole.log)   console.log   = originalConsole.log;
        if (originalConsole.info)  console.info  = originalConsole.info;
        if (originalConsole.warn)  console.warn  = originalConsole.warn;
        if (originalConsole.error) console.error  = originalConsole.error;
        if (originalConsole.debug) console.debug  = originalConsole.debug;
        isConsoleIntercepted = false;
    } catch (e) {
        console.error(`[${extensionName}] restoreConsole error:`, e);
    }
}

// ── Extract stack trace from args that contain Error objects ──
function extractStackFromArgs(args) {
    for (const arg of args) {
        if (arg instanceof Error && arg.stack) {
            // Return first 3 lines of stack trace for concise display
            const lines = arg.stack.split("\n").slice(0, 3);
            return lines.join("\n");
        }
    }
    return null;
}

// ============================================================
// BACKEND: SSE + Global Errors + Network Events
// ============================================================
// Strategy: ONLY monitor/observe — NEVER intercept fetch or XHR
// which would break ST's API calls. We passively capture:
// 1. eventSource (SSE) connection state changes
// 2. Key SSE events (expanded list from v5)
// 3. window.onerror — uncaught JS errors
// 4. window.onunhandledrejection — unhandled Promise rejections
// 5. navigator online/offline events
// All tagged "backend" with target field for origin context.
function interceptBackend() {
    if (isBackendIntercepted) return;
    try {
        // 1. SSE Connection Monitoring
        if (typeof eventSource !== "undefined" && eventSource.readyState !== undefined) {
            const onOpen = () => {
                safeAddLog("info", ["[SSE] Connection established to backend server"], "backend", "SSE.open");
            };
            eventSource.addEventListener("open", onOpen);

            const onError = () => {
                const state = eventSource.readyState;
                const stateDesc = state === 0 ? "CONNECTING" : state === 1 ? "OPEN" : state === 2 ? "CLOSED" : "UNKNOWN";
                safeAddLog("error", [`[SSE] Connection error — readyState: ${stateDesc} (${state})`], "backend", "SSE.error");
            };
            eventSource.addEventListener("error", onError);

            backendCleanupFns.push(() => {
                try { eventSource.removeEventListener("open", onOpen); } catch(e) {}
                try { eventSource.removeEventListener("error", onError); } catch(e) {}
            });

            // Expanded SSE events — more SillyTavern lifecycle coverage
            const backendEvents = [
                "app_ready",
                "message_generation_started",
                "message_generation_finished",
                "message_generation_aborted",
                "message_generation_error",
                "character_loaded",
                "chat_loaded",
                "group_loaded",
                "streaming_started",
                "streaming_finished",
                "persona_loaded",
                "world_info_loaded",
            ];

            backendEvents.forEach(eventName => {
                const handler = (e) => {
                    let detail = "";
                    try {
                        if (e.data) detail = ` — data: ${e.data.substring(0, 120)}`;
                    } catch (ex) { /* no data */ }
                    safeAddLog("info", [`[SSE] Event: ${eventName}${detail}`], "backend", `SSE.${eventName}`);
                };
                eventSource.addEventListener(eventName, handler);
                backendCleanupFns.push(() => {
                    try { eventSource.removeEventListener(eventName, handler); } catch(e) {}
                });
            });
        }

        // 2. Global Uncaught Errors
        const onErrorHandler = (e) => {
            const msg = e.message || "Unknown error";
            const src = e.filename || "unknown";
            const line = e.lineno || "?";
            const col = e.colno || "?";
            const stack = e.error?.stack?.split("\n").slice(0, 3).join("\n") || null;
            safeAddLog("error", [`[Uncaught] ${msg} at ${src}:${line}:${col}`], "backend", "window.onerror", stack);
        };
        window.addEventListener("error", onErrorHandler);
        backendCleanupFns.push(() => window.removeEventListener("error", onErrorHandler));

        // 3. Unhandled Promise Rejections
        const onRejectionHandler = (e) => {
            const reason = e.reason;
            let msg = "Unhandled Promise rejection";
            let stack = null;
            if (reason instanceof Error) {
                msg = `${reason.message}`;
                if (reason.stack) stack = reason.stack.split("\n").slice(0, 3).join("\n");
            } else if (typeof reason === "string") {
                msg = reason;
            } else {
                try { msg = safeStringify(reason).substring(0, 150); }
                catch (ex) { msg = String(reason).substring(0, 150); }
            }
            safeAddLog("error", [`[Promise] ${msg}`], "backend", "unhandledrejection", stack);
        };
        window.addEventListener("unhandledrejection", onRejectionHandler);
        backendCleanupFns.push(() => window.removeEventListener("unhandledrejection", onRejectionHandler));

        // 4. Network Connectivity Changes
        const onOffline = () => {
            safeAddLog("warn", ["[Network] Device went OFFLINE — backend unreachable"], "backend", "network.offline");
        };
        const onOnline = () => {
            safeAddLog("info", ["[Network] Device back ONLINE — reconnecting to backend"], "backend", "network.online");
        };
        window.addEventListener("offline", onOffline);
        window.addEventListener("online", onOnline);
        backendCleanupFns.push(() => {
            window.removeEventListener("offline", onOffline);
            window.removeEventListener("online", onOnline);
        });

        // Log initial state
        const esState = typeof eventSource !== "undefined" ?
            (eventSource.readyState === 1 ? "OPEN" : eventSource.readyState === 0 ? "CONNECTING" : "CLOSED") :
            "NOT_AVAILABLE";
        const isOnline = navigator.onLine ? "ONLINE" : "OFFLINE";

        safeAddLog("info", [`[Backend Monitor] Started — SSE: ${esState}, Network: ${isOnline}`], "backend", "init");

        isBackendIntercepted = true;
    } catch (e) {
        console.error(`[${extensionName}] interceptBackend setup error:`, e);
    }
}

// ============================================================
// LOG ADD + ANTI-RECURSION
// ============================================================
function safeAddLog(level, args, source, target, stack) {
    if (isInsideAddLog) return;
    isInsideAddLog = true;
    try { addLog(level, args, source, target, stack); }
    catch (e) { originalConsole.error?.(`[${extensionName}] addLog error:`, e); }
    finally { isInsideAddLog = false; }
}

function addLog(level, args, source, target, stack) {
    const maxEntries = extension_settings[extensionName]?.maxEntries || defaultSettings.maxEntries;
    const now = Date.now(); // epoch ms (TauriTavern pattern)
    const timestamp = new Date(now).toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const message = formatArgs(args);
    const logEntry = {
        id: logIdCounter++,           // Unique numeric ID (TauriTavern pattern)
        timestampMs: now,             // Epoch ms for stable comparison
        level,
        message,
        source: source || "frontend",
        target: target || null,       // Origin context (e.g., "console.warn", "SSE.open")
        stack: stack || null,         // Stack trace (for Error objects)
        timestamp,                    // Formatted string for display
    };

    logs.push(logEntry);

    // Eviction: keep only last maxEntries (TauriTavern uses pop, we use slice)
    if (logs.length > maxEntries) {
        logs = logs.slice(-maxEntries);
        lastRenderedLogIndex = -1; // Reset since array was trimmed
    }

    updateStats();

    if (isMonitorOpen) {
        scheduleIncrementalRender();
    }
}

// ── Better Args Serialization ──
// Handles Error objects, circular references, depth limits, multi-arg formatting
function formatArgs(args) {
    return args.map(arg => {
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        if (arg instanceof Error) {
            // Error objects: show name + message (stack is captured separately)
            return `${arg.name}: ${arg.message}`;
        }
        if (typeof arg === "object") {
            try {
                const str = safeStringify(arg, MAX_OBJECT_DEPTH);
                return str.length > 500 ? str.substring(0, 500) + "... [truncated]" : str;
            } catch (e) { return String(arg).substring(0, 200); }
        }
        const str = String(arg);
        return str.length > 500 ? str.substring(0, 500) + "... [truncated]" : str;
    }).join(" ");
}

// ── Safe JSON stringify with depth limit and circular ref detection ──
function safeStringify(obj, maxDepth, seenSet) {
    if (maxDepth === undefined) maxDepth = MAX_OBJECT_DEPTH;
    if (seenSet === undefined) seenSet = new Set();

    if (obj === null) return "null";
    if (obj === undefined) return "undefined";
    if (typeof obj !== "object") return JSON.stringify(obj);

    // Circular reference detection
    if (seenSet.has(obj)) return "[Circular]";
    seenSet.add(obj);

    if (maxDepth <= 0) return "[Object]";

    if (Array.isArray(obj)) {
        const items = obj.slice(0, 10).map(item => safeStringify(item, maxDepth - 1, seenSet));
        return `[${items.join(",")}${obj.length > 10 ? `, ...(${obj.length} items)` : ""}]`;
    }

    const keys = Object.keys(obj).slice(0, 15);
    const pairs = keys.map(key => {
        const val = safeStringify(obj[key], maxDepth - 1, seenSet);
        return `"${key}":${val}`;
    });
    const suffix = Object.keys(obj).length > 15 ? `, ...(${Object.keys(obj).length} keys)` : "";
    return `{${pairs.join(",")}${suffix}}`;
}

// ============================================================
// PERFORMANCE: Batched + Incremental Rendering
// ============================================================
function scheduleIncrementalRender() {
    pendingRenderType = "incremental";
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
        requestAnimationFrame(() => {
            if (pendingRenderType === "incremental") {
                doIncrementalRender();
            } else if (pendingRenderType === "full") {
                doFullRender();
            }
            pendingRenderType = "none";
        });
    }, RENDER_DEBOUNCE_MS);
}

function scheduleFullRender() {
    pendingRenderType = "full";
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
        requestAnimationFrame(() => {
            doFullRender();
            pendingRenderType = "none";
        });
    }, RENDER_DEBOUNCE_MS);
}

// ── Incremental Render ──
// Prepends new log entries at the top of the container.
// Only processes logs that haven't been rendered yet.
function doIncrementalRender() {
    try {
        const container = document.getElementById("ecl_log_container");
        if (!container) return;

        const settings = extension_settings[extensionName];
        const activeSource = settings?.activeSource || "frontend";
        const activeFilter = settings?.activeFilter || "ALL";
        const searchInput = document.getElementById("ecl_search_input");
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : "";

        // Find new logs since last render
        const startIndex = lastRenderedLogIndex + 1;
        const newLogs = logs.slice(startIndex);
        lastRenderedLogIndex = logs.length - 1;

        if (newLogs.length === 0) return;

        // Filter new logs matching current view (multi-field search)
        const matchingNewLogs = newLogs.filter(log => {
            if (log.source !== activeSource) return false;
            if (activeFilter !== "ALL" && log.level !== activeFilter.toLowerCase()) return false;
            if (searchTerm && !matchSearch(log, searchTerm)) return false;
            return true;
        });

        // Remove empty state message if present
        const emptyEl = container.querySelector(".ecl-log-empty");
        if (emptyEl) emptyEl.remove();

        // Prepend matching new logs at the top (newest first)
        for (let i = matchingNewLogs.length - 1; i >= 0; i--) {
            const log = matchingNewLogs[i];
            const entryEl = createLogEntryElement(log);
            container.prepend(entryEl);
        }

        trimDomEntries(container);
        ensureToggleVisible();
    } catch (e) {
        originalConsole.error?.(`[${extensionName}] incremental render error:`, e);
    }
}

// ── Full Render ──
// Rebuilds all log entries. Used on open, filter change, source change, search.
function doFullRender() {
    try {
        const container = document.getElementById("ecl_log_container");
        if (!container) return;

        const filteredLogs = getFilteredLogs();

        if (filteredLogs.length === 0) {
            // Differentiate empty states (TauriTavern pattern)
            const emptyMsg = logs.length === 0
                ? "No logs captured yet. Logs will appear here in real-time."
                : "No logs match your current filter or search.";
            container.innerHTML = `
                <div class="ecl-log-empty">
                    <span class="fa-solid fa-terminal"></span>
                    <span>${emptyMsg}</span>
                </div>
            `;
            lastRenderedLogIndex = logs.length - 1;
            ensureToggleVisible();
            return;
        }

        // REVERSE: newest at top, oldest at bottom
        // Only render last MAX_RENDERED_ENTRIES to prevent DOM bloat
        const displayLogs = filteredLogs.slice(-MAX_RENDERED_ENTRIES).reverse();

        // Build HTML efficiently using DocumentFragment
        const fragment = document.createDocumentFragment();
        displayLogs.forEach(log => {
            fragment.appendChild(createLogEntryElement(log));
        });

        container.innerHTML = "";
        container.appendChild(fragment);

        lastRenderedLogIndex = logs.length - 1;
        ensureToggleVisible();
    } catch (e) {
        originalConsole.error?.(`[${extensionName}] full render error:`, e);
    }
}

// ── Create Single Log Entry Element ──
// Enhanced with target field display and stack trace (v6)
function createLogEntryElement(log) {
    const entry = document.createElement("div");
    entry.className = `ecl-log-entry ecl-level-${log.level} ecl-source-${log.source}`;
    entry.dataset.logId = log.id; // Stable numeric ID for DOM keying

    const levelClass = `ecl-badge-${log.level}`;
    const safeMessage = escapeHtml(log.message)
        .replace(/`([^`]+)`/g, '<code class="ecl-inline-code">$1</code>');

    // Build meta row with optional target display
    const targetHtml = log.target
        ? `<span class="ecl-log-target">${escapeHtml(log.target)}</span>`
        : `<span class="ecl-log-source">${log.source}</span>`;

    // Stack trace section (collapsible for errors/warnings)
    let stackHtml = "";
    if (log.stack) {
        const safeStack = escapeHtml(log.stack);
        stackHtml = `<div class="ecl-log-stack" onclick="this.classList.toggle('ecl-stack-expanded')">${safeStack}</div>`;
    }

    entry.innerHTML = `
        <div class="ecl-log-entry-meta">
            <span class="ecl-log-timestamp">${log.timestamp}</span>
            <span class="ecl-log-level-badge ${levelClass}">${log.level.toUpperCase()}</span>
            ${targetHtml}
        </div>
        <div class="ecl-log-message">${safeMessage}</div>
        ${stackHtml}
    `;

    return entry;
}

// ── Trim DOM entries to max limit ──
function trimDomEntries(container) {
    const entries = container.querySelectorAll(".ecl-log-entry");
    if (entries.length > MAX_RENDERED_ENTRIES) {
        const excess = entries.length - MAX_RENDERED_ENTRIES;
        for (let i = entries.length - 1; i >= entries.length - excess; i--) {
            entries[i].remove();
        }
    }
}

function clearLogs() {
    logs = [];
    logIdCounter = 0;
    lastRenderedLogIndex = -1;
    toastDedupMap.clear();
    ensureToggleVisible();
    scheduleFullRender();
    updateStats();
}

function copyVisibleLogs() {
    try {
        const visibleEntries = getFilteredLogs();
        // TauriTavern-style formatted output: [HH:MM:SS] [LEVEL] [target] message
        const text = visibleEntries.map(log => {
            const target = log.target ? `[${log.target}]` : `[${log.source}]`;
            const stackSuffix = log.stack ? `\n  Stack: ${log.stack}` : "";
            return `[${log.timestamp}] [${log.level.toUpperCase()}] ${target} ${log.message}${stackSuffix}`;
        }).join("\n");

        if (text.length === 0) {
            toastr.info("No logs to copy", "Easy Console Log");
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            toastr.success("Logs copied to clipboard", "Easy Console Log");
        }).catch(() => {
            // Fallback for environments where clipboard API is restricted
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            toastr.success("Logs copied to clipboard", "Easy Console Log");
        });
    } catch (e) {
        console.error(`[${extensionName}] copyVisibleLogs error:`, e);
    }
}

// ── Log Filtering (multi-field search — TauriTavern pattern) ──
// Search across message, level, source, and target fields
function getFilteredLogs() {
    try {
        const settings = extension_settings[extensionName];
        const activeSource = settings?.activeSource || "frontend";
        const activeFilter = settings?.activeFilter || "ALL";
        const searchInput = document.getElementById("ecl_search_input");
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : "";

        return logs.filter(log => {
            if (log.source !== activeSource) return false;
            if (activeFilter !== "ALL" && log.level !== activeFilter.toLowerCase()) return false;
            if (searchTerm && !matchSearch(log, searchTerm)) return false;
            return true;
        });
    } catch (e) {
        console.error(`[${extensionName}] getFilteredLogs error:`, e);
        return [];
    }
}

// Multi-field search: matches against message, level, source, target
function matchSearch(log, term) {
    const fields = [
        log.message || "",
        log.level || "",
        log.source || "",
        log.target || "",
    ];
    return fields.some(field => field.toLowerCase().includes(term));
}

// ── Stats ──
function updateStats() {
    try {
        // Stats are source-specific (show counts for current view)
        const settings = extension_settings[extensionName];
        const activeSource = settings?.activeSource || "frontend";
        const sourceLogs = logs.filter(l => l.source === activeSource);
        const entries = sourceLogs.length;
        const warnings = sourceLogs.filter(l => l.level === "warn").length;
        const errors = sourceLogs.filter(l => l.level === "error").length;

        const entriesEl = document.getElementById("ecl_stats_entries");
        const warningsEl = document.getElementById("ecl_stats_warnings");
        const errorsEl = document.getElementById("ecl_stats_errors");

        if (entriesEl) entriesEl.textContent = `${entries} entries`;
        if (warningsEl) warningsEl.textContent = `${warnings} warnings`;
        if (errorsEl) errorsEl.textContent = `${errors} errors`;
    } catch (e) { /* non-critical */ }
}

// ── HTML Escape ──
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// DEDUPLICATED TOAST NOTIFICATIONS (TauriTavern repeatCount pattern)
// ============================================================
// Instead of showing a new toast for every warn/error, we deduplicate:
// - If the same message was shown within TOAST_DEDUP_WINDOW_MS,
//   we increment a repeat counter on the existing toast instead
//   of creating a new one. Prevents notification spam.
function dedupedToast(level, args) {
    try {
        const message = formatArgs(args);
        const dedupKey = `${level}:${message.substring(0, 60)}`;
        const now = Date.now();

        const existing = toastDedupMap.get(dedupKey);
        if (existing && (now - existing.lastShownMs) < TOAST_DEDUP_WINDOW_MS) {
            // Duplicate within window — increment counter, update existing toast
            existing.count++;
            existing.lastShownMs = now;

            // Update the existing toast's counter display
            const toastEl = document.querySelector(".ecl-toast");
            if (toastEl) {
                const counterEl = toastEl.querySelector(".ecl-toast-count");
                if (counterEl) {
                    counterEl.textContent = ` (${existing.count})`;
                } else {
                    const span = document.createElement("span");
                    span.className = "ecl-toast-count";
                    span.textContent = ` (${existing.count})`;
                    toastEl.appendChild(span);
                }
                // Extend visibility timer
                if (toastTimeout) clearTimeout(toastTimeout);
                toastTimeout = setTimeout(() => {
                    const t = document.querySelector(".ecl-toast");
                    if (t) {
                        t.style.animation = "eclToastOut 0.3s ease forwards";
                        setTimeout(() => t.remove(), 300);
                    }
                }, 4000);
            }
            return; // Don't create new toast
        }

        // New unique toast — remove any existing one first
        $(".ecl-toast").remove();

        const truncatedMsg = message.length > 80 ? message.substring(0, 80) + "..." : message;
        const toastClass = level === "error" ? "ecl-toast-error" : "ecl-toast-warn";
        const icon = level === "error" ? "fa-solid fa-circle-exclamation" : "fa-solid fa-triangle-exclamation";

        const toast = $(`
            <div class="ecl-toast ${toastClass}">
                <span class="${icon}"></span>
                <span>${escapeHtml(truncatedMsg)}</span>
            </div>
        `);

        $("body").append(toast);

        // Record in dedup map
        toastDedupMap.set(dedupKey, { count: 1, lastShownMs: now });

        // Clean old entries from dedup map (prevent unbounded growth)
        for (const [key, val] of toastDedupMap) {
            if (now - val.lastShownMs > TOAST_DEDUP_WINDOW_MS * 2) {
                toastDedupMap.delete(key);
            }
        }

        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            const t = document.querySelector(".ecl-toast");
            if (t) {
                t.style.animation = "eclToastOut 0.3s ease forwards";
                setTimeout(() => t.remove(), 300);
            }
        }, 4000);

        toast.on("click", () => {
            toast.css("animation", "eclToastOut 0.3s ease forwards");
            setTimeout(() => toast.remove(), 300);
        });
    } catch (e) { /* non-critical */ }
}
