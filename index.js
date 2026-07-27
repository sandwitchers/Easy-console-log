// ============================================================
// Easy Console Log — SillyTavern Extension (v2)
// Captures and displays console logs in a premium overlay UI
// Newest logs appear at TOP — no scroll needed for latest entries
// ============================================================
//
// CRITICAL SAFETY MEASURES:
// 1. Only import what we ACTUALLY USE — unused imports can crash ST
// 2. Console interception is DELAYED until ST finishes loading
// 3. Every operation is wrapped in try/catch to prevent ST hangs
// 4. addLog is protected against recursive loops during interception
//

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "Easy-console-log";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ── State ──
const defaultSettings = {
    enabled: true,
    captureBrowserConsole: true,
    showNotifications: true,
    maxEntries: 200,
    activeSource: "frontend",
    activeFilter: "ALL",
};

let logs = [];
let originalConsole = {};
let isConsoleIntercepted = false;
let isMonitorOpen = false;
let toastTimeout = null;
let isInsideAddLog = false; // Anti-recursion guard

// ── Initialize (safe, non-blocking) ──
jQuery(async () => {
    try {
        // Load settings HTML (gear icon drawer) — append to right panel
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings2").append(settingsHtml);

        // Load monitor HTML (overlay) — append to body
        const monitorHtml = await $.get(`${extensionFolderPath}/monitor.html`);
        $("body").append(monitorHtml);

        // Initialize settings storage
        initSettings();

        // Bind UI events (safe, no side effects)
        bindEvents();

        // IMPORTANT: Do NOT intercept console during ST initialization!
        // We delay interception until ST is fully loaded.
        waitForSillyTavernReady().then(() => {
            if (extension_settings[extensionName].captureBrowserConsole) {
                interceptConsole();
            }
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
        // Strategy 1: event-based
        if (typeof eventSource !== "undefined" && eventSource.addEventListener) {
            eventSource.addEventListener("app_ready", () => resolve(), { once: true });
        }
        // Strategy 2: timeout fallback (5s)
        setTimeout(resolve, 5000);
    });
}

// ── Settings Management ──
function initSettings() {
    try {
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        if (Object.keys(extension_settings[extensionName]).length === 0) {
            Object.assign(extension_settings[extensionName], defaultSettings);
        }

        const settings = extension_settings[extensionName];

        const captureCheckbox = document.getElementById("ecl_capture_checkbox");
        if (captureCheckbox) captureCheckbox.checked = settings.captureBrowserConsole;

        $(".ecl-toggle-btn").removeClass("ecl-toggle-active");
        const activeSourceBtn = $(`.ecl-toggle-btn[data-source="${settings.activeSource}"]`);
        if (activeSourceBtn.length) activeSourceBtn.addClass("ecl-toggle-active");

        $(".ecl-filter-pill").removeClass("ecl-filter-active");
        const activeFilterBtn = $(`.ecl-filter-pill[data-level="${settings.activeFilter}"]`);
        if (activeFilterBtn.length) activeFilterBtn.addClass("ecl-filter-active");
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
        // Open/close monitor
        $("#easy_console_log_open_btn").on("click", openMonitor);
        $("#ecl_close_btn").on("click", closeMonitor);
        $(".ecl-overlay-backdrop").on("click", closeMonitor);

        // Source toggle
        $(".ecl-toggle-btn").on("click", function () {
            $(".ecl-toggle-btn").removeClass("ecl-toggle-active");
            $(this).addClass("ecl-toggle-active");
            saveSetting("activeSource", $(this).data("source"));
            renderLogs();
        });

        // Capture checkbox
        $("#ecl_capture_checkbox").on("change", function () {
            const checked = $(this).prop("checked");
            saveSetting("captureBrowserConsole", checked);
            if (checked) interceptConsole();
            else restoreConsole();
        });

        // Search input (debounced)
        let searchDebounce = null;
        $("#ecl_search_input").on("input", function () {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => renderLogs(), 150);
        });

        // Copy / Clear
        $("#ecl_copy_btn").on("click", copyVisibleLogs);
        $("#ecl_clear_btn").on("click", clearLogs);

        // Level filter pills
        $(".ecl-filter-pill").on("click", function () {
            $(".ecl-filter-pill").removeClass("ecl-filter-active");
            $(this).addClass("ecl-filter-active");
            saveSetting("activeFilter", $(this).data("level"));
            renderLogs();
        });
    } catch (e) {
        console.error(`[${extensionName}] bindEvents error:`, e);
    }
}

// ── Monitor Open / Close ──
function openMonitor() {
    isMonitorOpen = true;
    const overlay = document.getElementById("easy-console-log-monitor-overlay");
    if (overlay) overlay.style.display = "flex";
    renderLogs();
}

function closeMonitor() {
    isMonitorOpen = false;
    const overlay = document.getElementById("easy-console-log-monitor-overlay");
    if (overlay) overlay.style.display = "none";
}

// ── Console Interception (safe, delayed) ──
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

// ── Safe Log Add (anti-recursion guard) ──
function safeAddLog(level, args, source) {
    if (isInsideAddLog) return;
    isInsideAddLog = true;
    try { addLog(level, args, source); }
    catch (e) { originalConsole.error(`[${extensionName}] addLog error:`, e); }
    finally { isInsideAddLog = false; }
}

function addLog(level, args, source) {
    const maxEntries = extension_settings[extensionName]?.maxEntries || defaultSettings.maxEntries;
    const now = new Date();
    const timestamp = now.toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const message = formatArgs(args);

    logs.push({ level, message, source: source || "frontend", timestamp });

    if (logs.length > maxEntries) {
        logs = logs.slice(-maxEntries);
    }

    if (isMonitorOpen) {
        renderLogs();
        updateStats();
    } else {
        updateStats();
    }
}

function formatArgs(args) {
    return args.map(arg => {
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        if (typeof arg === "object") {
            try { return JSON.stringify(arg, null, 2); }
            catch (e) { return String(arg); }
        }
        return String(arg);
    }).join(" ");
}

function clearLogs() {
    logs = [];
    renderLogs();
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

// ── Log Filtering & Rendering ──
// Newest logs render at TOP — no auto-scroll needed
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

function renderLogs() {
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
            return;
        }

        // REVERSE: newest log at top, oldest at bottom
        const reversedLogs = filteredLogs.slice().reverse();

        const html = reversedLogs.map(log => {
            const levelClass = `ecl-level-${log.level}`;
            const badgeClass = `ecl-badge-${log.level}`;
            const safeMessage = escapeHtml(log.message)
                .replace(/`([^`]+)`/g, '<code class="ecl-inline-code">$1</code>');

            return `
                <div class="ecl-log-entry ${levelClass}">
                    <div class="ecl-log-entry-meta">
                        <span class="ecl-log-timestamp">${log.timestamp}</span>
                        <span class="ecl-log-level-badge ${badgeClass}">${log.level.toUpperCase()}</span>
                        <span class="ecl-log-source">${log.source}</span>
                    </div>
                    <div class="ecl-log-message">${safeMessage}</div>
                </div>
            `;
        }).join("");

        container.innerHTML = html;
    } catch (e) {
        if (originalConsole.error) {
            originalConsole.error(`[${extensionName}] renderLogs error:`, e);
        }
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
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
    } catch (e) {
        // Silent — stats are non-critical
    }
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
    } catch (e) {
        // Non-critical, silent
    }
}
