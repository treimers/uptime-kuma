const { log } = require("../../src/util");
const { checkLogin } = require("../util-server");
const { Backup } = require("../backup");
const { Proxy } = require("../proxy");
const {
    sendNotificationList,
    sendProxyList,
    sendDockerHostList,
    sendRemoteBrowserList,
} = require("../client");

const VALID_IMPORT_HANDLES = ["skip", "keep", "overwrite"];

/**
 * Normalize import handle from mixed client/server versions
 * @param {any} value Raw import handle value
 * @returns {string} Valid import handle
 */
function normalizeImportHandle(value) {
    if (typeof value === "string" && VALID_IMPORT_HANDLES.includes(value)) {
        return value;
    }
    return "skip";
}

/**
 * Parse uploadBackup socket arguments from current and legacy clients
 * @param {Array<any>} args Socket handler arguments
 * @returns {{uploadedJSON: string, importHandle: string, deleteBefore: boolean, callback: Function}} Parsed args
 */
function parseUploadBackupArgs(args) {
    const [uploadedJSON, secondArg, thirdArg, fourthArg] = args;
    let callback = () => {};

    for (const arg of [fourthArg, thirdArg, secondArg]) {
        if (typeof arg === "function") {
            callback = arg;
            break;
        }
    }

    // Current format: (json, { importHandle, deleteBefore }, callback)
    if (typeof secondArg === "object" && secondArg !== null && !Array.isArray(secondArg)) {
        return {
            uploadedJSON,
            importHandle: normalizeImportHandle(secondArg.importHandle),
            deleteBefore: secondArg.deleteBefore === true,
            callback,
        };
    }

    // Legacy format: (json, importHandle, deleteBefore, callback?)
    if (typeof thirdArg === "boolean") {
        return {
            uploadedJSON,
            importHandle: normalizeImportHandle(secondArg),
            deleteBefore: thirdArg === true,
            callback,
        };
    }

    // Legacy format: (json, importHandle, callback)
    if (typeof thirdArg === "function") {
        return {
            uploadedJSON,
            importHandle: normalizeImportHandle(secondArg),
            deleteBefore: false,
            callback: thirdArg,
        };
    }

    // Broken/partial client calls: (json, callback)
    if (typeof secondArg === "function") {
        return {
            uploadedJSON,
            importHandle: "skip",
            deleteBefore: false,
            callback: secondArg,
        };
    }

    // Swapped args from mixed frontend versions: (json, deleteBefore, importHandle)
    if (typeof secondArg === "boolean" && typeof thirdArg === "string") {
        return {
            uploadedJSON,
            importHandle: normalizeImportHandle(thirdArg),
            deleteBefore: secondArg === true,
            callback,
        };
    }

    return {
        uploadedJSON,
        importHandle: normalizeImportHandle(secondArg),
        deleteBefore: false,
        callback,
    };
}

/**
 * Handlers for backup export and import
 * @param {Socket} socket Socket.io instance
 * @param {UptimeKumaServer} server Uptime Kuma server
 * @param {object} helpers Helper functions from server.js
 * @returns {void}
 */
module.exports.backupSocketHandler = (socket, server, helpers) => {
    socket.on("getBackup", async (includeSensitive, callback) => {
        if (typeof includeSensitive === "function") {
            callback = includeSensitive;
            includeSensitive = false;
        }

        if (typeof callback !== "function") {
            callback = () => {};
        }

        try {
            checkLogin(socket);

            const backupData = await Backup.export(socket.userID, includeSensitive === true);

            callback({
                ok: true,
                backup: backupData,
            });
        } catch (e) {
            log.error("backup", e.message);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("uploadBackup", async (...args) => {
        const { uploadedJSON, importHandle, deleteBefore, callback } = parseUploadBackupArgs(args);

        try {
            checkLogin(socket);

            const backupData = typeof uploadedJSON === "string" ? JSON.parse(uploadedJSON) : uploadedJSON;

            log.info(
                "manage",
                `Importing backup, User ID: ${socket.userID}, Version: ${backupData.version || "unknown"}, deleteBefore: ${deleteBefore}`
            );

            await Backup.import(socket.userID, backupData, importHandle, helpers, deleteBefore);

            await Proxy.reloadProxy();
            await sendNotificationList(socket);
            await sendProxyList(socket);
            await sendDockerHostList(socket);
            await sendRemoteBrowserList(socket);
            await server.sendMonitorList(socket);

            callback({
                ok: true,
                msg: "successBackupRestored",
                msgi18n: true,
            });
        } catch (e) {
            log.error("backup", e.message);
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
