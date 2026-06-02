<template>
    <div>
        <div class="my-4">
            <h4 class="mt-4 mb-2">{{ $t("Export Backup") }}</h4>

            <p>
                {{ $t("backupDescription") }} <br />
                ({{ $t("backupDescription2") }}) <br />
            </p>

            <div class="form-check mb-3">
                <input
                    id="include-sensitive"
                    v-model="includeSensitiveData"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="include-sensitive">
                    {{ $t("includeSensitiveData") }}
                </label>
            </div>

            <div class="form-text mb-3">
                {{ includeSensitiveData ? $t("backupDescription3") : $t("includeSensitiveDataHint") }}
            </div>

            <div class="mb-2">
                <button class="btn btn-primary" :disabled="exportProcessing" @click="downloadBackup">
                    <div v-if="exportProcessing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Export") }}
                </button>
            </div>
        </div>

        <div class="my-4">
            <h4 class="mt-4 mb-2">{{ $t("Import Backup") }}</h4>

            <label class="form-label">{{ $t("Options") }}:</label>
            <br />
            <div class="form-check form-check-inline">
                <input
                    id="radioKeep"
                    v-model="importHandle"
                    class="form-check-input"
                    type="radio"
                    name="radioImportHandle"
                    value="keep"
                />
                <label class="form-check-label" for="radioKeep">
                    {{ $t("Keep both") }}
                </label>
            </div>
            <div class="form-check form-check-inline">
                <input
                    id="radioSkip"
                    v-model="importHandle"
                    class="form-check-input"
                    type="radio"
                    name="radioImportHandle"
                    value="skip"
                />
                <label class="form-check-label" for="radioSkip">
                    {{ $t("Skip existing") }}
                </label>
            </div>
            <div class="form-check form-check-inline">
                <input
                    id="radioOverwrite"
                    v-model="importHandle"
                    class="form-check-input"
                    type="radio"
                    name="radioImportHandle"
                    value="overwrite"
                />
                <label class="form-check-label" for="radioOverwrite">
                    {{ $t("Overwrite") }}
                </label>
            </div>
            <div class="form-text mb-2">
                {{ $t("importHandleDescription") }}
            </div>

            <div class="form-check mb-3">
                <input
                    id="delete-before-restore"
                    v-model="deleteBeforeRestore"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="delete-before-restore">
                    {{ $t("deleteBeforeRestore") }}
                </label>
            </div>

            <div class="form-text mb-3">
                {{ $t("deleteBeforeRestoreHint") }}
            </div>

            <div class="mb-2">
                <input id="import-backend" type="file" class="form-control" accept="application/json" />
            </div>

            <div class="input-group mb-2 justify-content-end">
                <button type="button" class="btn btn-outline-primary" :disabled="processing" @click="confirmImport">
                    <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Import") }}
                </button>
            </div>

            <div v-if="importAlert" class="alert alert-danger mt-3" style="padding: 6px 16px">
                {{ importAlert }}
            </div>
        </div>

        <Confirm
            ref="confirmImport"
            btn-style="btn-danger"
            :yes-text="$t('Yes')"
            :no-text="$t('No')"
            @yes="importBackup"
        >
            {{ confirmImportMessage }}
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../Confirm.vue";
import dayjs from "dayjs";

export default {
    components: {
        Confirm,
    },

    data() {
        return {
            includeSensitiveData: false,
            importHandle: "skip",
            deleteBeforeRestore: false,
            processing: false,
            exportProcessing: false,
            importAlert: null,
        };
    },

    computed: {
        confirmImportMessage() {
            if (this.deleteBeforeRestore || this.importHandle === "overwrite") {
                return this.$t("confirmImportDeleteBeforeMsg");
            }
            return this.$t("confirmImportMsg");
        },
    },

    methods: {
        /**
         * Download a backup of the configuration
         * @returns {void}
         */
        downloadBackup() {
            this.exportProcessing = true;

            this.$root.getBackup(this.includeSensitiveData, (res) => {
                this.exportProcessing = false;

                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }

                const time = dayjs().format("YYYY_MM_DD-HH_mm_ss");
                const fileName = `Uptime_Kuma_Backup_${time}.json`;
                const exportData = JSON.stringify(res.backup, null, 4);
                const downloadItem = document.createElement("a");
                downloadItem.setAttribute(
                    "href",
                    "data:application/json;charset=utf-8," + encodeURIComponent(exportData)
                );
                downloadItem.setAttribute("download", fileName);
                downloadItem.click();
            });
        },

        /**
         * Show import confirmation dialog
         * @returns {void}
         */
        confirmImport() {
            this.importAlert = null;
            this.$refs.confirmImport.show();
        },

        /**
         * Import the specified backup file
         * @returns {string|void} Error message
         */
        importBackup() {
            this.processing = true;
            const uploadItem = document.getElementById("import-backend").files;

            if (uploadItem.length <= 0) {
                this.processing = false;
                return (this.importAlert = this.$t("alertNoFile"));
            }

            if (uploadItem.item(0).type !== "application/json") {
                this.processing = false;
                return (this.importAlert = this.$t("alertWrongFileType"));
            }

            const fileReader = new FileReader();
            fileReader.readAsText(uploadItem.item(0));

            fileReader.onload = (item) => {
                this.$root.uploadBackup(item.target.result, this.importHandle, this.deleteBeforeRestore, (res) => {
                    this.processing = false;
                    this.$root.toastRes(res);

                    if (res.ok) {
                        document.getElementById("import-backend").value = "";
                    }
                });
            };
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.dark {
    #import-backend {
        &::file-selector-button {
            color: $primary;
            background-color: $dark-bg;
        }

        &:hover:not(:disabled):not([readonly])::file-selector-button {
            color: $dark-font-color2;
            background-color: $primary;
        }
    }
}
</style>
