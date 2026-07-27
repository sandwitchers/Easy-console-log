// ============================================================
// Easy Console Log — SillyTavern Extension
// Captures and displays console logs in a premium overlay UI
// ============================================================

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "Easy-console-log";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ── Settings ──
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
let isMonitorOpen = false;
let autoScrollEnabled = true;
let toastTimeout = null;

// ── Initialize ──
jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);

    try {
        // Load settings HTML (gear icon drawer)
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings2").append(settingsHtml);

        // Load monitor HTML (overlay panel)
        const monitorHtml = await $.get(`${extensionFolderPath}/monitor.html`);
        $("body").append(monitorHtml);

        // Load saved settings
        loadSettings();

        // Bind all event handlers
        bindEvents();

        // Intercept console methods
        interceptConsole();

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});

// ── Settings Management ──
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    const settings = extension_settings[extensionName];

    // Apply saved settings to UI
    $("#ecl_capture_checkbox").prop("checked", settings.captureBrowserConsole);
    
    // Restore source toggle state
    $(".ecl-toggle-btn").removeClass("ecl-toggle-active");
    $(`.ecl-toggle-btn[data-source="${settings.activeSource}"]`).addClass("ecl-toggle-active");

    // Restore filter state
    $(".ecl-filter-pill").removeClass("ecl-filter-active");
    $(`.ecl-filter-pill[data-level="${settings.activeFilter}"]`).addClass("ecl-filter-active");

    // Update capture state
    if (settings.captureBrowserConsole) {
        interceptConsole();
    } else {
        restoreConsole();
    }
}

function saveSetting(key, value) {
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
}

// ── Event Binding ──
function bindEvents() {
    // Open monitor button
    $("#easy_console_log_open_btn").on("click", openMonitor);

    // Close monitor
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
        if (checked) {
            interceptConsole();
        } else {
            restoreConsole();
        }
    });

    // Search input
    $("#ecl_search_input").on("input", function () {
        renderLogs();
    });

    // Copy visible
    $("#ecl_copy_btn").on("click", copyVisibleLogs);

    // Clear logs
    $("#ecl_clear_btn").on("click", clearLogs);

    // Level filter pills
    $(".ecl-filter-pill").on("click", function () {
        $(".ecl-filter-pill").removeClass("ecl-filter-active");
        $(this).addClass("ecl-filter-active");
        saveSetting("activeFilter", $(this).data("level"));
        renderLogs();
    });

    // Auto-scroll indicator click
    $("#ecl_autoscroll_indicator").on("click", function () {
        scrollToBottom();
        $(this).hide();
    });
}

// ── Monitor Open / Close ──
function openMonitor() {
    isMonitorOpen = true;
    $("#easy-console-log-monitor-overlay").show();
    renderLogs();
    scrollToBottom();
}

function closeMonitor() {
    isMonitorOpen = false;
    $("#easy-console-log-monitor-overlay").hide();
}

// ── Console Interception ──
function interceptConsole() {
    // Store originals so we can restore them
    originalConsole.log   = console.log;
    originalConsole.info  = console.info;
    originalConsole.warn  = console.warn;
    originalConsole.error = console.error;
    originalConsole.debug = console.debug;

    const settings = extension_settings[extensionName];

    console.log = function (...args) {
        originalConsole.log.apply(console, args);
        if (settings.captureBrowserConsole) {
            addLog("info", args, "browser");
        }
    };

    console.info = function (...args) {
        originalConsole.info.apply(console, args);
        if (settings.captureBrowserConsole) {
            addLog("info", args, "browser");
        }
    };

    console.warn = function (...args) {
        originalConsole.warn.apply(console, args);
        if (settings.captureBrowserConsole) {
            addLog("warn", args, "browser");
            if (settings.showNotifications) showToast("warn", args);
        }
    };

    console.error = function (...args) {
        originalConsole.error.apply(console, args);
        if (settings.captureBrowserConsole) {
            addLog("error", args, "browser");
            if (settings.showNotifications) showToast("error", args);
        }
    };

    console.debug = function (...args) {
        originalConsole.debug.apply(console, args);
        if (settings.captureBrowserConsole) {
            addLog("debug", args, "browser");
        }
    };
}

function restoreConsole() {
    if (originalConsole.log)   console.log   = originalConsole.log;
    if (originalConsole.info)  console.info  = originalConsole.info;
    if (originalConsole.warn)  console.warn  = originalConsole.warn;
    if (originalConsole.error) console.error  = originalConsole.error;
    if (originalConsole.debug) console.debug  = originalConsole.debug;
}

// ── Log Management ──
function addLog(level, args, source) {
    const maxEntries = extension_settings[extensionName].maxEntries || defaultSettings.maxEntries;
    const now = new Date();
    const timestamp = now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const message = formatArgs(args);

    logs.push({
        level,
        message,
        source: source || "frontend",
        timestamp,
        rawArgs: args,
    });

    // Trim if over max
    if (logs.length > maxEntries) {
        logs = logs.slice(-maxEntries);
    }

    // Update UI if monitor is open
    if (isMonitorOpen) {
        renderLogs();
        updateStats();

        // Auto-scroll logic
        const container = document.getElementById("ecl_log_container");
        if (container) {
            const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
            if (isNearBottom || autoScrollEnabled) {
                scrollToBottom();
            } else {
                $("#ecl_autoscroll_indicator").show();
            }
        }
    } else {
        updateStats();
    }
}

function formatArgs(args) {
    return args.map(arg => {
        if (arg === null) return "null";
        if (arg === undefined) return "undefined";
        if (typeof arg === "object") {
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return String(arg);
            }
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
    const visibleEntries = getFilteredLogs();
    const text = visibleEntries.map(log => {
        return `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.source}] ${log.message}`;
    }).join("\n");

    if (text.length === 0) {
        toastr.info("No logs to copy", "Easy Console Log");
        return;
    }

    navigator.clipboard.writeText(text).then(() => {
        toastr.success("Logs copied to clipboard", "Easy Console Log");
    }).catch(() => {
        // Fallback for older browsers
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
}

// ── Log Filtering & Rendering ──
function getFilteredLogs() {
    const settings = extension_settings[extensionName];
    const activeSource = settings.activeSource || "frontend";
    const activeFilter = settings.activeFilter || "ALL";
    const searchTerm = ($("#ecl_search_input").val() || "").toLowerCase().trim();

    return logs.filter(log => {
        // Source filter
        if (log.source !== activeSource) return false;

        // Level filter
        if (activeFilter !== "ALL" && log.level !== activeFilter.toLowerCase()) return false;

        // Search filter
        if (searchTerm && !log.message.toLowerCase().includes(searchTerm)) return false;

        return true;
    });
}

function renderLogs() {
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

    // Build HTML for all visible entries
    const html = filteredLogs.map(log => {
        const levelClass = `ecl-level-${log.level}`;
        const badgeClass = `ecl-badge-${log.level}`;

        // Sanitize and format message for display
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
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ── Stats ──
function updateStats() {
    const entries = logs.length;
    const warnings = logs.filter(l => l.level === "warn").length;
    const errors = logs.filter(l => l.level === "error").length;

    $("#ecl_stats_entries").text(`${entries} entries`);
    $("#ecl_stats_warnings").text(`${warnings} warnings`);
    $("#ecl_stats_errors").text(`${errors} errors`);
}

// ── Auto-scroll ──
function scrollToBottom() {
    const container = document.getElementById("ecl_log_container");
    if (container) {
        container.scrollTop = container.scrollHeight;
        $("#ecl_autoscroll_indicator").hide();
    }
}

// ── Toast Notifications ──
function showToast(level, args) {
    // Remove existing toast
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

    // Auto-remove after 4 seconds
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.css("animation", "eclToastOut 0.3s ease forwards");
        setTimeout(() => toast.remove(), 300);
    }, 4000);

    // Click to dismiss
    toast.on("click", () => {
        toast.css("animation", "eclToastOut 0.3s ease forwards");
        setTimeout(() => toast.remove(), 300);
    });
}

// ── Cleanup on extension unload (if ST supports it) ──
function unloadExtension() {
    restoreConsole();
    $(".ecl-toast").remove();
    $("#easy-console-log-monitor-overlay").remove();
}
