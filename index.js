// ============================================================
// Easy Console Log — SillyTavern Extension (v5)
// ============================================================
// NEW IN v5:
// - BACKEND LOG CAPTURE: eventSource (SSE) monitoring,
//   global JS errors, network status changes — tagged "backend"
// - PERFORMANCE OVERHAUL: batched debounced rendering,
//   incremental prepend for new logs, max DOM entries limit
//   prevents freeze when rapid logs arrive or monitor is opened
//
// CRITICAL SAFETY MEASURES:
// 1. Only import what we ACTUALLY USE — unused imports crash ST
// 2. Console interception DELAYED until ST finishes loading
// 3. Every operation wrapped in try/catch to prevent ST hangs
// 4. Anti-recursion guard on addLog
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
const MAX_RENDERED_ENTRIES = 100; // Only render last 100 entries in DOM
const RENDER_DEBOUNCE_MS = 200;   // Batch rapid log arrivals into 1 render

// ── State ──
const defaultSettings = {
    enabled: true,
    captureBrowserConsole: true,
    captureBackendEvents: true,
    showNotifications: true,
    maxEntries: 200,
    activeSource: "frontend",
    activeFilter: "ALL",
};

let logs = [];
let originalConsole = {};
let isConsoleIntercepted = false;
let isBackendIntercepted = false;
let isMonitorOpen = false;
let toastTimeout = null;
let isInsideAddLog = false;
let renderDebounceTimer = null;
let pendingRenderType = "none"; // "full" | "incremental"
let lastRenderedLogIndex = -1;  // Track which logs have been rendered

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
    // Full render on open — reset rendered index
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
// FRONTEND: Console Interception
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
            try { originalConsole.log(...args); if (settings.captureBrowserConsole) safeAddLog("info", args, "frontend"); }
            catch (e) { originalConsole.error(`[${extensionName}] console.log interceptor error:`, e); }
        };

        console.info = function (...args) {
            try { originalConsole.info(...args); if (settings.captureBrowserConsole) safeAddLog("info", args, "frontend"); }
            catch (e) { originalConsole.error(`[${extensionName}] console.info interceptor error:`, e); }
        };

        console.warn = function (...args) {
            try { originalConsole.warn(...args); if (settings.captureBrowserConsole) { safeAddLog("warn", args, "frontend"); if (settings.showNotifications) showToast("warn", args); } }
            catch (e) { originalConsole.error(`[${extensionName}] console.warn interceptor error:`, e); }
        };

        console.error = function (...args) {
            try { originalConsole.error(...args); if (settings.captureBrowserConsole) { safeAddLog("error", args, "frontend"); if (settings.showNotifications) showToast("error", args); } }
            catch (e) { originalConsole.error(`[${extensionName}] console.error interceptor error:`, e); }
        };

        console.debug = function (...args) {
            try { originalConsole.debug(...args); if (settings.captureBrowserConsole) safeAddLog("debug", args, "frontend"); }
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

// ============================================================
// BACKEND: SSE + Global Errors + Network Events
// ============================================================
// Strategy: ONLY monitor/observe — NEVER intercept fetch or XHR
// which would break ST's API calls. We passively capture:
// 1. eventSource (SSE) connection state changes
// 2. Key SSE events (app_ready, generation events, etc.)
// 3. window.onerror — uncaught JS errors (often from failed API calls)
// 4. window.onunhandledrejection — unhandled Promise rejections
// 5. navigator online/offline events — network connectivity changes
function interceptBackend() {
    if (isBackendIntercepted) return;
    try {
        // 1. SSE Connection Monitoring
        if (typeof eventSource !== "undefined" && eventSource.readyState !== undefined) {
            // Monitor connection state changes
            eventSource.addEventListener("open", () => {
                safeAddLog("info", ["[SSE] Connection established to backend server"], "backend");
            });

            eventSource.addEventListener("error", () => {
                const state = eventSource.readyState;
                const stateDesc = state === 0 ? "CONNECTING" : state === 1 ? "OPEN" : state === 2 ? "CLOSED" : "UNKNOWN";
                safeAddLog("error", [`[SSE] Connection error — readyState: ${stateDesc} (${state})`], "backend");
            });

            // Monitor key backend events
            const backendEvents = [
                "app_ready",
                "message_generation_started",
                "message_generation_finished",
                "message_generation_aborted",
                "message_generation_error",
                "character_loaded",
                "chat_loaded",
                "group_loaded",
            ];

            backendEvents.forEach(eventName => {
                eventSource.addEventListener(eventName, (e) => {
                    let detail = "";
                    try {
                        if (e.data) detail = ` — data: ${e.data.substring(0, 100)}`;
                    } catch (ex) { /* no data */ }
                    safeAddLog("info", [`[SSE] Event: ${eventName}${detail}`], "backend");
                });
            });
        }

        // 2. Global Uncaught Errors
        window.addEventListener("error", (e) => {
            const msg = e.message || "Unknown error";
            const src = e.filename || "unknown";
            const line = e.lineno || "?";
            const col = e.colno || "?";
            safeAddLog("error", [`[Uncaught] ${msg} at ${src}:${line}:${col}`], "backend");
        });

        // 3. Unhandled Promise Rejections
        window.addEventListener("unhandledrejection", (e) => {
            const reason = e.reason;
            let msg = "Unhandled Promise rejection";
            if (reason instanceof Error) {
                msg = `${reason.message} at ${reason.stack?.split("\n")[0] || "unknown"}`;
            } else if (typeof reason === "string") {
                msg = reason;
            } else {
                try { msg = JSON.stringify(reason).substring(0, 100); }
                catch (ex) { msg = String(reason).substring(0, 100); }
            }
            safeAddLog("error", [`[Promise] ${msg}`], "backend");
        });

        // 4. Network Connectivity Changes
        window.addEventListener("offline", () => {
            safeAddLog("warn", ["[Network] Device went OFFLINE — backend unreachable"], "backend");
        });

        window.addEventListener("online", () => {
            safeAddLog("info", ["[Network] Device back ONLINE — reconnecting to backend"], "backend");
        });

        // Log initial state
        const esState = typeof eventSource !== "undefined" ?
            (eventSource.readyState === 1 ? "OPEN" : eventSource.readyState === 0 ? "CONNECTING" : "CLOSED") :
            "NOT_AVAILABLE";
        const isOnline = navigator.onLine ? "ONLINE" : "OFFLINE";

        safeAddLog("info", [`[Backend Monitor] Started — SSE: ${esState}, Network: ${isOnline}`], "backend");

        isBackendIntercepted = true;
    } catch (e) {
        console.error(`[${extensionName}] interceptBackend setup error:`, e);
    }
}

// ============================================================
// LOG ADD + ANTI-RECURSION
// ============================================================
function safeAddLog(level, args, source) {
    if (isInsideAddLog) return;
    isInsideAddLog = true;
    try { addLog(level, args, source); }
    catch (e) { originalConsole.error?.(`[${extensionName}] addLog error:`, e); }
    finally { isInsideAddLog = false; }
}

function addLog(level, args, source) {
    const maxEntries = extension_settings[extensionName]?.maxEntries || defaultSettings.maxEntries;
    const now = new Date();
    const timestamp = now.toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const message = formatArgs(args);
    const logEntry = { level, message, source: source || "frontend", timestamp };

    logs.push(logEntry);

    if (logs.length > maxEntries) {
        logs = logs.slice(-maxEntries);
        // Reset rendered index since array was trimmed
        lastRenderedLogIndex = -1;
    }

    updateStats();

    if (isMonitorOpen) {
        // PERFORMANCE: Instead of immediate render, schedule batched render.
        // If new logs arrive rapidly, they're batched into one update.
        scheduleIncrementalRender();
    }
}

function formatArgs(args) {
    return args.map(arg => {
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        if (typeof arg === "object") {
            try {
                const str = JSON.stringify(arg);
                // Truncate very long objects to prevent DOM bloat
                return str.length > 500 ? str.substring(0, 500) + "... [truncated]" : str;
            } catch (e) { return String(arg).substring(0, 200); }
        }
        const str = String(arg);
        return str.length > 500 ? str.substring(0, 500) + "... [truncated]" : str;
    }).join(" ");
}

// ============================================================
// PERFORMANCE: Batched + Incremental Rendering
// ============================================================
// Instead of rebuilding ALL DOM entries every time a log arrives,
// we use two render strategies:
// 1. INCREMENTAL: When a new log arrives while monitor is open,
//    prepend only the new entry at the top. Much cheaper than
//    rebuilding all entries.
// 2. FULL: When filter/source/search changes, rebuild everything.
//    Also used on first open and after clear.
//
// Both are debounced — rapid log bursts are batched into 1 render.

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

        // Filter new logs matching current view
        const matchingNewLogs = newLogs.filter(log => {
            if (log.source !== activeSource) return false;
            if (activeFilter !== "ALL" && log.level !== activeFilter.toLowerCase()) return false;
            if (searchTerm && !log.message.toLowerCase().includes(searchTerm)) return false;
            return true;
        });

        // Remove empty state message if present
        const emptyEl = container.querySelector(".ecl-log-empty");
        if (emptyEl) emptyEl.remove();

        // Prepend matching new logs at the top (newest first)
        // We iterate in reverse order so the latest log ends up at top
        for (let i = matchingNewLogs.length - 1; i >= 0; i--) {
            const log = matchingNewLogs[i];
            const entryEl = createLogEntryElement(log);
            container.prepend(entryEl);
        }

        // Trim DOM entries that exceed max rendered limit
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
            const emptyMsg = logs.length === 0
                ? "No logs captured yet. Logs will appear here in real-time."
                : "No logs match your current filter.";
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
// Reusable for both incremental and full render.
function createLogEntryElement(log) {
    const entry = document.createElement("div");
    entry.className = `ecl-log-entry ecl-level-${log.level} ecl-source-${log.source}`;

    const levelClass = `ecl-badge-${log.level}`;
    const safeMessage = escapeHtml(log.message)
        .replace(/`([^`]+)`/g, '<code class="ecl-inline-code">$1</code>');

    entry.innerHTML = `
        <div class="ecl-log-entry-meta">
            <span class="ecl-log-timestamp">${log.timestamp}</span>
            <span class="ecl-log-level-badge ${levelClass}">${log.level.toUpperCase()}</span>
            <span class="ecl-log-source">${log.source}</span>
        </div>
        <div class="ecl-log-message">${safeMessage}</div>
    `;

    return entry;
}

// ── Trim DOM entries to max limit ──
// Removes oldest entries (at bottom of container) when count exceeds limit
function trimDomEntries(container) {
    const entries = container.querySelectorAll(".ecl-log-entry");
    if (entries.length > MAX_RENDERED_ENTRIES) {
        // Remove from bottom (oldest entries)
        const excess = entries.length - MAX_RENDERED_ENTRIES;
        for (let i = entries.length - 1; i >= entries.length - excess; i--) {
            entries[i].remove();
        }
    }
}

function clearLogs() {
    logs = [];
    lastRenderedLogIndex = -1;
    ensureToggleVisible();
    scheduleFullRender();
    updateStats();
}

function copyVisibleLogs() {
    try {
        const visibleEntries = getFilteredLogs();
        const text = visibleEntries.map(log =>
            `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`
        ).join("\n");

        if (text.length === 0) {
            toastr.info("No logs to copy", "Easy Console Log");
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            toastr.success("Logs copied to clipboard", "Easy Console Log");
        }).catch(() => {
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

// ── Log Filtering ──
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
            if (searchTerm && !log.message.toLowerCase().includes(searchTerm)) return false;
            return true;
        });
    } catch (e) {
        console.error(`[${extensionName}] getFilteredLogs error:`, e);
        return [];
    }
}

// ── Stats ──
function updateStats() {
    try {
        const entries = logs.length;
        const warnings = logs.filter(l => l.level === "warn").length;
        const errors = logs.filter(l => l.level === "error").length;

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

// ── Toast Notifications ──
function showToast(level, args) {
    try {
        $(".ecl-toast").remove();

        const message = formatArgs(args);
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

        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.css("animation", "eclToastOut 0.3s ease forwards");
            setTimeout(() => toast.remove(), 300);
        }, 4000);

        toast.on("click", () => {
            toast.css("animation", "eclToastOut 0.3s ease forwards");
            setTimeout(() => toast.remove(), 300);
        });
    } catch (e) { /* non-critical */ }
}
