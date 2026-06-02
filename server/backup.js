const { R } = require("redbean-node");
const { log } = require("../src/util");
const Monitor = require("./model/monitor");
const { Notification } = require("./notification");
const { Proxy } = require("./proxy");
const { DockerHost } = require("./docker");
const { RemoteBrowser } = require("./remote-browser");
const { UptimeKumaServer } = require("./uptime-kuma-server");
const version = require("../package.json").version;

const BACKUP_VERSION = 2;

const SENSITIVE_KEY_PATTERN =
    /(?:^|_)(password|pass|secret|token|apikey|api_key|privatekey|private_key|credentials?|bearer|pushToken|webhook)(?:$|_)/i;

const MONITOR_EXPORT_ONLY_FIELDS = [
    "path",
    "pathName",
    "childrenIDs",
    "screenshot",
    "dns_last_result",
    "maintenance",
    "includeSensitiveData",
    "forceInactive",
    "tags",
];

const FRONTEND_ONLY_MONITOR_FIELDS = ["humanReadableInterval", "globalpingdnsresolvetypeoptions", "responsecheck"];

/**
 * Check if an object key likely contains sensitive data
 * @param {string} key Object key
 * @returns {boolean} True if sensitive
 */
function isSensitiveKey(key) {
    return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Remove sensitive values from an object recursively
 * @param {object} obj Object to redact
 * @returns {object} Redacted object
 */
function redactSensitiveFields(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        return obj;
    }

    for (const key of Object.keys(obj)) {
        if (isSensitiveKey(key)) {
            obj[key] = "";
        } else if (typeof obj[key] === "object" && obj[key] !== null) {
            redactSensitiveFields(obj[key]);
        }
    }

    return obj;
}

/**
 * Export notification from database bean
 * @param {Bean} bean Notification bean
 * @param {boolean} includeSensitive Include secrets in export
 * @returns {object} Notification data
 */
function exportNotificationItem(bean, includeSensitive) {
    const data = JSON.parse(bean.config);
    data.id = bean.id;
    data.name = bean.name;
    data.isDefault = bean.is_default === 1;
    data.active = bean.active === 1;

    if (!includeSensitive) {
        redactSensitiveFields(data);
    }

    return data;
}

/**
 * Normalize legacy or current notification export format
 * @param {object} item Notification item from backup file
 * @returns {object} Notification object for Notification.save
 */
function normalizeNotificationItem(item) {
    if (item.config) {
        const parsed = typeof item.config === "string" ? JSON.parse(item.config) : item.config;
        parsed.id = item.id;
        parsed.name = item.name || parsed.name;
        parsed.isDefault = item.isDefault ?? item.is_default === 1;
        parsed.active = typeof item.active === "boolean" ? item.active : item.active === 1;
        parsed.type = parsed.type || item.type;
        return parsed;
    }

    const copy = { ...item };
    delete copy.id;
    delete copy.user_id;
    return copy;
}

/**
 * JSON-encode a monitor field unless it is already stored as JSON text
 * @param {any} value Field value
 * @param {any} defaultValue Default value when missing
 * @returns {string} JSON string for database storage
 */
function stringifyMonitorField(value, defaultValue) {
    if (value === undefined || value === null) {
        return JSON.stringify(defaultValue);
    }

    if (typeof value === "string") {
        return value;
    }

    return JSON.stringify(value);
}

/**
 * Export proxy data
 * @param {Bean} bean Proxy bean
 * @param {boolean} includeSensitive Include password in export
 * @returns {object} Proxy data
 */
function exportProxyItem(bean, includeSensitive) {
    const data = bean.toJSON();

    if (!includeSensitive) {
        data.password = "";
    }

    return data;
}

/**
 * Convert monitor list object to array
 * @param {object|array} monitorList Monitor list from backup
 * @returns {array} Monitor array
 */
function normalizeMonitorList(monitorList) {
    if (Array.isArray(monitorList)) {
        return monitorList;
    }

    return Object.values(monitorList || {});
}

/**
 * Prepare monitor object for database import
 * @param {object} monitor Monitor data
 * @returns {{monitor: object, notificationIDList: object}} Prepared monitor
 */
function prepareMonitorForImport(monitor) {
    const copy = { ...monitor };
    delete copy.id;

    for (const field of MONITOR_EXPORT_ONLY_FIELDS) {
        delete copy[field];
    }

    for (const field of FRONTEND_ONLY_MONITOR_FIELDS) {
        delete copy[field];
    }

    const notificationIDList = copy.notificationIDList || {};
    delete copy.notificationIDList;

    if (copy.proxy_id != null && copy.proxyId == null) {
        copy.proxyId = copy.proxy_id;
    }
    delete copy.proxy_id;

    if (copy.accepted_statuscodes) {
        copy.accepted_statuscodes_json = JSON.stringify(copy.accepted_statuscodes);
        delete copy.accepted_statuscodes;
    } else if (!copy.accepted_statuscodes_json) {
        copy.accepted_statuscodes_json = JSON.stringify(["200-299"]);
    }

    if (copy.retryInterval === undefined || copy.retryInterval === null) {
        copy.retryInterval = 0;
    }

    if (copy.timeout === undefined || copy.timeout === null) {
        copy.timeout = Math.round((copy.interval || 60) * 0.8);
    }

    copy.kafkaProducerBrokers = stringifyMonitorField(copy.kafkaProducerBrokers, []);
    copy.kafkaProducerSaslOptions = stringifyMonitorField(copy.kafkaProducerSaslOptions, {});
    copy.conditions = stringifyMonitorField(copy.conditions, []);
    copy.rabbitmqNodes = stringifyMonitorField(copy.rabbitmqNodes, []);

    return {
        monitor: copy,
        notificationIDList,
    };
}

class Backup {
    /**
     * Export user configuration as JSON-serializable object
     * @param {number} userID User ID
     * @param {boolean} includeSensitive Include secrets in export
     * @returns {Promise<object>} Backup data
     */
    static async export(userID, includeSensitive) {
        const monitorData = await R.getAll("SELECT id, active, name FROM monitor WHERE user_id = ?", [userID]);
        const preloadData = await Monitor.preparePreloadData(monitorData);
        const monitorBeans = await R.find("monitor", " user_id = ? ORDER BY weight DESC, name", [userID]);
        const exportedMonitors = monitorBeans.map((monitor) => monitor.toJSON(preloadData, includeSensitive));

        const notificationBeans = await R.find("notification", " user_id = ? ", [userID]);
        const notificationList = notificationBeans.map((bean) => exportNotificationItem(bean, includeSensitive));

        const proxyBeans = await R.find("proxy", " user_id = ? ", [userID]);
        const proxyList = proxyBeans.map((bean) => exportProxyItem(bean, includeSensitive));

        const dockerHostBeans = await R.find("docker_host", " user_id = ? ", [userID]);
        const dockerHostList = dockerHostBeans.map((bean) => bean.toJSON());

        const remoteBrowserBeans = await R.find("remote_browser", " user_id = ? ", [userID]);
        const remoteBrowserList = remoteBrowserBeans.map((bean) => bean.toJSON());

        const tagBeans = await R.findAll("tag");
        const tagList = tagBeans.map((bean) => bean.toJSON());

        return {
            backupVersion: BACKUP_VERSION,
            version,
            exportedAt: new Date().toISOString(),
            includeSensitive,
            notificationList,
            proxyList,
            dockerHostList,
            remoteBrowserList,
            tagList,
            monitorList: exportedMonitors,
        };
    }

    /**
     * Delete exported configuration for a user before restore
     * @param {number} userID User ID
     * @returns {Promise<void>}
     */
    static async deleteUserConfiguration(userID) {
        const server = UptimeKumaServer.getInstance();

        for (const id in server.monitorList) {
            const runningMonitor = server.monitorList[id];
            if (runningMonitor.user_id == userID) {
                await runningMonitor.stop();
                delete server.monitorList[id];
            }
        }

        await R.exec("DELETE FROM heartbeat WHERE monitor_id IN (SELECT id FROM monitor WHERE user_id = ?)", [userID]);
        await R.exec("DELETE FROM monitor_notification WHERE monitor_id IN (SELECT id FROM monitor WHERE user_id = ?)", [userID]);
        await R.exec("DELETE FROM monitor_tls_info WHERE monitor_id IN (SELECT id FROM monitor WHERE user_id = ?)", [userID]);
        await R.exec("DELETE FROM notification WHERE user_id = ?", [userID]);
        await R.exec("DELETE FROM monitor_tag WHERE monitor_id IN (SELECT id FROM monitor WHERE user_id = ?)", [userID]);
        await R.exec("DELETE FROM monitor WHERE user_id = ?", [userID]);
        await R.exec("DELETE FROM proxy WHERE user_id = ?", [userID]);
        await R.exec("DELETE FROM docker_host WHERE user_id = ?", [userID]);
        await R.exec("DELETE FROM remote_browser WHERE user_id = ?", [userID]);

        log.info("manage", `Backup restore: deleted existing configuration for user ${userID}`);
    }

    /**
     * Import backup data
     * @param {number} userID User ID
     * @param {object} backupData Parsed backup JSON
     * @param {string} importHandle skip, keep, or overwrite
     * @param {object} helpers Helper functions from server
     * @param {boolean} deleteBefore Delete existing configuration before import
     * @returns {Promise<void>}
     */
    static async import(userID, backupData, importHandle, helpers, deleteBefore = false) {
        const { startMonitor, pauseMonitor, updateMonitorNotification } = helpers;

        const notificationListData = backupData.notificationList || [];
        const proxyListData = backupData.proxyList || [];
        const dockerHostListData = backupData.dockerHostList || [];
        const remoteBrowserListData = backupData.remoteBrowserList || [];
        const monitorListData = normalizeMonitorList(backupData.monitorList);

        if (deleteBefore || importHandle === "overwrite") {
            await Backup.deleteUserConfiguration(userID);
            // Name lists must be refreshed after deletion
        }

        const notificationIdMap = new Map();
        const proxyIdMap = new Map();
        const dockerHostIdMap = new Map();
        const remoteBrowserIdMap = new Map();
        const monitorIdMap = new Map();
        const pendingParents = [];

        const notificationNameList = await R.getCol("SELECT name FROM notification WHERE user_id = ?", [userID]);
        const monitorNameList = await R.getCol("SELECT name FROM monitor WHERE user_id = ?", [userID]);

        for (const rawItem of notificationListData) {
            const notification = normalizeNotificationItem(rawItem);
            const oldId = rawItem.id;
            const name = notification.name;

            if (importHandle === "skip" && notificationNameList.includes(name)) {
                const existing = await R.findOne("notification", " user_id = ? AND name = ? ", [userID, name]);
                if (existing && oldId) {
                    notificationIdMap.set(oldId, existing.id);
                }
                continue;
            }

            delete notification.id;
            notification.applyExisting = false;
            const bean = await Notification.save(notification, null, userID);

            if (oldId) {
                notificationIdMap.set(oldId, bean.id);
            }
        }

        for (const proxy of proxyListData) {
            const oldId = proxy.id;
            const exists = oldId ? await R.findOne("proxy", " id = ? AND user_id = ? ", [oldId, userID]) : null;

            if (["skip", "keep"].includes(importHandle) && exists) {
                if (oldId) {
                    proxyIdMap.set(oldId, exists.id);
                }
                continue;
            }

            const proxyData = { ...proxy };
            delete proxyData.id;
            delete proxyData.userId;
            delete proxyData.createdDate;
            proxyData.applyExisting = false;

            const bean = await Proxy.save(proxyData, importHandle === "overwrite" && exists ? exists.id : undefined, userID);

            if (oldId) {
                proxyIdMap.set(oldId, bean.id);
            }
        }

        for (const dockerHost of dockerHostListData) {
            const oldId = dockerHost.id;
            const exists = oldId
                ? await R.findOne("docker_host", " id = ? AND user_id = ? ", [oldId, userID])
                : null;

            if (["skip", "keep"].includes(importHandle) && exists) {
                if (oldId) {
                    dockerHostIdMap.set(oldId, exists.id);
                }
                continue;
            }

            const bean = await DockerHost.save(dockerHost, importHandle === "overwrite" && exists ? exists.id : undefined, userID);

            if (oldId) {
                dockerHostIdMap.set(oldId, bean.id);
            }
        }

        for (const remoteBrowser of remoteBrowserListData) {
            const oldId = remoteBrowser.id;
            const exists = oldId
                ? await R.findOne("remote_browser", " id = ? AND user_id = ? ", [oldId, userID])
                : null;

            if (["skip", "keep"].includes(importHandle) && exists) {
                if (oldId) {
                    remoteBrowserIdMap.set(oldId, exists.id);
                }
                continue;
            }

            const bean = await RemoteBrowser.save(
                remoteBrowser,
                importHandle === "overwrite" && exists ? exists.id : undefined,
                userID
            );

            if (oldId) {
                remoteBrowserIdMap.set(oldId, bean.id);
            }
        }

        for (const monitorData of monitorListData) {
            if (importHandle === "skip" && monitorNameList.includes(monitorData.name)) {
                continue;
            }

            const oldId = monitorData.id;
            const oldParent = monitorData.parent;
            const tags = monitorData.tags || [];
            const shouldBeActive = monitorData.active !== false && monitorData.active !== 0;

            const { monitor, notificationIDList } = prepareMonitorForImport(monitorData);

            monitor.parent = null;

            if (monitor.proxyId && proxyIdMap.has(monitor.proxyId)) {
                monitor.proxyId = proxyIdMap.get(monitor.proxyId);
            } else if (monitor.proxyId) {
                monitor.proxyId = null;
            }

            if (monitor.docker_host && dockerHostIdMap.has(monitor.docker_host)) {
                monitor.docker_host = dockerHostIdMap.get(monitor.docker_host);
            } else if (monitor.docker_host) {
                monitor.docker_host = null;
            }

            if (monitor.remote_browser && remoteBrowserIdMap.has(monitor.remote_browser)) {
                monitor.remote_browser = remoteBrowserIdMap.get(monitor.remote_browser);
            } else if (monitor.remote_browser) {
                monitor.remote_browser = null;
            }

            const remappedNotificationIDList = {};
            for (const notificationID in notificationIDList) {
                if (!notificationIDList[notificationID]) {
                    continue;
                }

                const mappedId = notificationIdMap.get(parseInt(notificationID));
                if (mappedId) {
                    remappedNotificationIDList[mappedId] = true;
                }
            }

            const bean = R.dispense("monitor");
            bean.import(monitor);

            if (monitor.retryOnlyOnStatusCodeFailure !== undefined) {
                bean.retry_only_on_status_code_failure = monitor.retryOnlyOnStatusCodeFailure;
            }

            bean.user_id = userID;
            bean.validate();
            await R.store(bean);

            if (oldId) {
                monitorIdMap.set(oldId, bean.id);
            }

            if (oldParent) {
                pendingParents.push({
                    monitorID: bean.id,
                    parentID: oldParent,
                });
            }

            await updateMonitorNotification(bean.id, remappedNotificationIDList);

            for (const oldTag of tags) {
                let tag = await R.findOne("tag", " name = ?", [oldTag.name]);
                let tagId;

                if (!tag) {
                    const beanTag = R.dispense("tag");
                    beanTag.name = oldTag.name;
                    beanTag.color = oldTag.color;
                    await R.store(beanTag);
                    tagId = beanTag.id;
                } else {
                    tagId = tag.id;
                }

                await R.exec("INSERT INTO monitor_tag (tag_id, monitor_id, value) VALUES (?, ?, ?)", [
                    tagId,
                    bean.id,
                    oldTag.value || "",
                ]);
            }

            if (shouldBeActive) {
                await startMonitor(userID, bean.id);
            } else {
                await pauseMonitor(userID, bean.id);
            }
        }

        for (const item of pendingParents) {
            const newParentId = monitorIdMap.get(item.parentID);
            if (newParentId) {
                await R.exec("UPDATE monitor SET parent = ? WHERE id = ? AND user_id = ?", [
                    newParentId,
                    item.monitorID,
                    userID,
                ]);
            }
        }

        log.info("manage", `Backup imported for user ${userID} (${importHandle})`);
    }
}

module.exports = {
    Backup,
};
