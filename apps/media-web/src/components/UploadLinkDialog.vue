<!-- Upload links (PV6) into one folder, for managers: the links that exist (files and bytes received, state;
     revoke) and a form for a new one (label, expiry, file count, size per file, types, review). A new link's URL is
     shown once. -->
<template>
  <el-dialog :model-value="!!folder" :title="$t('uploadLink.title', { folder: folder || '/' })" width="min(620px, 94vw)" append-to-body data-test="upload-link-dialog" @close="$emit('close')">
    <template v-if="folder">
      <el-alert v-if="!publicSharing" type="info" :closable="false" show-icon :title="$t('library.sharingOff')" />
      <template v-else>
        <p class="pv-muted small">{{ $t("uploadLink.explain") }}</p>
        <el-alert v-if="created" type="success" :closable="false" class="created" data-test="upload-link-created">
          <template #title>{{ $t("share.createdOnce") }}</template>
          <div class="url-row">
            <el-input :model-value="created" readonly data-test="upload-link-url" />
            <el-button type="primary" @click="copy(created)">{{ $t("links.copy") }}</el-button>
          </div>
        </el-alert>
        <el-form label-position="top" @submit.prevent="create">
          <div class="grid">
            <el-form-item :label="$t('uploadLink.label')"><el-input v-model="form.label" size="small" maxlength="100" :placeholder="$t('uploadLink.labelHint')" data-test="upload-link-label" /></el-form-item>
            <el-form-item :label="$t('share.expires')">
              <el-select v-model="form.expiresIn" size="small">
                <el-option v-for="o in expiries" :key="o.key" :value="o.seconds" :label="$t(`share.expiry.${o.key}`)" />
              </el-select>
            </el-form-item>
            <el-form-item :label="$t('uploadLink.maxFiles')"><el-input-number v-model="form.maxFiles" :min="1" :max="1000" size="small" controls-position="right" /></el-form-item>
            <el-form-item :label="$t('uploadLink.maxFileMb')"><el-input-number v-model="form.maxFileMb" :min="1" :max="50" size="small" controls-position="right" /></el-form-item>
            <el-form-item :label="$t('uploadLink.types')">
              <el-select v-model="form.types" size="small">
                <el-option value="any" :label="$t('uploadLink.typeAny')" />
                <el-option value="images" :label="$t('uploadLink.typeImages')" />
                <el-option value="docs" :label="$t('uploadLink.typeDocs')" />
              </el-select>
            </el-form-item>
            <el-form-item :label="$t('uploadLink.review')"><el-switch v-model="form.requiresReview" /></el-form-item>
          </div>
          <el-button type="primary" native-type="submit" :loading="busy" data-test="upload-link-create">{{ $t("uploadLink.create") }}</el-button>
        </el-form>

        <h3 class="section">{{ $t("share.existing") }}</h3>
        <el-skeleton v-if="loading" :rows="2" animated />
        <p v-else-if="!links.length" class="pv-muted small">{{ $t("share.none") }}</p>
        <ul v-else class="links">
          <li v-for="l in links" :key="l.id">
            <el-tag size="small" :type="l.status === 'active' ? 'success' : 'info'">{{ $t(`uploadLink.state.${l.status}`) }}</el-tag>
            <strong>{{ l.label || $t("uploadLink.unnamed") }}</strong>
            <span class="pv-muted small">· {{ $t("uploadLink.received", { n: l.uploads, max: l.limits.maxFiles }) }}</span>
            <span v-if="l.expiresAt" class="pv-muted small">· {{ $t("share.until", { at: new Date(l.expiresAt).toLocaleString() }) }}</span>
            <span class="grow" />
            <el-button v-if="l.status === 'active' || l.status === 'full'" size="small" text type="danger" @click="revoke(l)">{{ $t("share.revoke") }}</el-button>
          </li>
        </ul>
      </template>
    </template>
  </el-dialog>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";

const EXPIRIES = [
  { key: "day", seconds: 86400 },
  { key: "week", seconds: 604800 },
  { key: "month", seconds: 2592000 },
];
const TYPES = { any: undefined, images: ["image/*"], docs: ["application/pdf", "text/plain", "image/*"] };

export default {
  name: "UploadLinkDialog",
  props: {
    folder: { type: String, default: null },
    org: { type: String, required: true },
    lib: { type: String, required: true },
    publicSharing: { type: Boolean, default: true },
  },
  emits: ["close"],
  data: () => ({ links: [], loading: false, busy: false, created: "", expiries: EXPIRIES, form: { label: "", expiresIn: 604800, maxFiles: 20, maxFileMb: 25, types: "any", requiresReview: true } }),
  watch: {
    folder: {
      immediate: true,
      handler(f) {
        this.created = "";
        if (f && this.publicSharing) this.load();
      },
    },
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        // The API lists the library's links; this dialog shows the ones into this folder.
        this.links = (await api.libraries.uploadLinks(this.org, this.lib)).uploadLinks.filter((l) => l.folder === this.folder);
      } catch {
        this.links = [];
      } finally {
        this.loading = false;
      }
    },
    async create() {
      this.busy = true;
      try {
        const body = {
          folder: this.folder,
          label: this.form.label.trim() || undefined,
          expiresIn: this.form.expiresIn,
          maxFiles: this.form.maxFiles,
          maxFileBytes: this.form.maxFileMb * 1024 * 1024,
          requiresReview: this.form.requiresReview,
        };
        if (TYPES[this.form.types]) body.allowedTypes = TYPES[this.form.types];
        const r = await api.libraries.createUploadLink(this.org, this.lib, body);
        this.created = r.url;
        await this.load();
      } catch (e) {
        ElMessage.error(e?.code === "public_sharing_off" ? this.$t("library.sharingOff") : e.message || this.$t("errors.generic"));
      } finally {
        this.busy = false;
      }
    },
    async revoke(l) {
      try {
        await ElMessageBox.confirm(this.$t("share.revokeConfirm"), { type: "warning" });
      } catch {
        return;
      }
      try {
        await api.libraries.revokeUploadLink(this.org, this.lib, l.id);
        ElMessage.success(this.$t("share.revoked"));
        await this.load();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        ElMessage.success(this.$t("links.copied"));
      } catch {
        ElMessage.info(text);
      }
    },
  },
};
</script>

<style scoped>
.created {
  margin-bottom: 12px;
}
.url-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0 16px;
}
.section {
  font-size: 0.95rem;
  margin: 16px 0 8px;
}
.links {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
}
.links li {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.grow {
  flex: 1;
}
.small {
  font-size: 0.8rem;
}
</style>
