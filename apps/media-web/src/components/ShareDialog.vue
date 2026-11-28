<!-- Share links (PV6) for one file, folder or collection: the links that exist (state, opens, downloads; revoke),
     and a form for a new one (view or download, expiry, password, download limit). A new link's URL is shown once:
     only its hash is kept, so it can't be shown again. -->
<template>
  <el-dialog :model-value="!!target" :title="title" width="min(620px, 94vw)" append-to-body data-test="share-dialog" @close="$emit('close')">
    <template v-if="target">
      <el-alert v-if="!publicSharing" type="info" :closable="false" show-icon :title="$t('library.sharingOff')" />
      <template v-else>
        <el-alert v-if="created" type="success" :closable="false" class="created" data-test="share-created">
          <template #title>{{ $t("share.createdOnce") }}</template>
          <div class="url-row">
            <el-input :model-value="created" readonly data-test="share-url" />
            <el-button type="primary" @click="copy(created)">{{ $t("links.copy") }}</el-button>
          </div>
        </el-alert>

        <el-form label-position="top" class="form" @submit.prevent="create">
          <div class="grid">
            <el-form-item :label="$t('share.mode')">
              <el-radio-group v-model="form.mode" size="small">
                <el-radio-button value="view">{{ $t("share.view") }}</el-radio-button>
                <el-radio-button value="download">{{ $t("share.download") }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item :label="$t('share.expires')">
              <el-select v-model="form.expiresIn" size="small" data-test="share-expiry">
                <el-option v-for="o in expiries" :key="o.key" :value="o.seconds" :label="$t(`share.expiry.${o.key}`)" />
              </el-select>
            </el-form-item>
            <el-form-item :label="$t('share.password')">
              <el-input v-model="form.password" type="password" size="small" show-password autocomplete="new-password" :placeholder="$t('share.optional')" data-test="share-password" />
            </el-form-item>
            <el-form-item :label="$t('share.maxDownloads')">
              <el-input-number v-model="form.maxDownloads" :min="1" :max="100000" size="small" controls-position="right" :placeholder="$t('share.unlimited')" />
            </el-form-item>
          </div>
          <p v-if="error" class="err small">{{ error }}</p>
          <el-button type="primary" native-type="submit" :loading="busy" data-test="share-create">{{ $t("share.create") }}</el-button>
        </el-form>

        <h3 class="section">{{ $t("share.existing") }}</h3>
        <el-skeleton v-if="loading" :rows="2" animated />
        <p v-else-if="!links.length" class="pv-muted small">{{ $t("share.none") }}</p>
        <ul v-else class="links" data-test="share-links">
          <li v-for="l in links" :key="l.id">
            <el-tag size="small" :type="stateType(l.status)">{{ $t(`share.state.${l.status}`) }}</el-tag>
            <span>{{ $t(`share.${l.mode}`) }}</span>
            <span v-if="l.hasPassword" class="pv-muted small">· {{ $t("share.withPassword") }}</span>
            <span class="pv-muted small">· {{ $t("share.opens", { n: l.opens }) }} · {{ l.maxDownloads ? $t("share.downloadsOf", { n: l.downloads, max: l.maxDownloads }) : $t("share.downloads", { n: l.downloads }) }}</span>
            <span v-if="l.expiresAt" class="pv-muted small">· {{ $t("share.until", { at: new Date(l.expiresAt).toLocaleString() }) }}</span>
            <span class="grow" />
            <el-button v-if="l.status === 'active'" size="small" text type="danger" data-test="share-revoke" @click="revoke(l)">{{ $t("share.revoke") }}</el-button>
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
  { key: "never", seconds: 0 },
];

export default {
  name: "ShareDialog",
  props: {
    /** { kind: "file", id, label } | { kind: "folder", path, label } | { kind: "collection", id, label } */
    target: { type: Object, default: null },
    org: { type: String, required: true },
    lib: { type: String, required: true },
    publicSharing: { type: Boolean, default: true },
  },
  emits: ["close"],
  data: () => ({ links: [], loading: false, busy: false, created: "", error: "", form: { mode: "view", expiresIn: 604800, password: "", maxDownloads: undefined }, expiries: EXPIRIES }),
  computed: {
    title() {
      return this.target ? this.$t("share.title", { name: this.target.label }) : "";
    },
    query() {
      const t = this.target;
      if (!t) return {};
      return t.kind === "file" ? { file: t.id } : t.kind === "folder" ? { folder: t.path } : { collection: t.id };
    },
  },
  watch: {
    target: {
      immediate: true,
      handler(t) {
        this.created = "";
        this.error = "";
        this.form = { mode: "view", expiresIn: 604800, password: "", maxDownloads: undefined };
        this.links = [];
        if (t && this.publicSharing) this.load();
      },
    },
  },
  methods: {
    stateType(s) {
      return { active: "success", expired: "info", revoked: "info", used_up: "warning" }[s] ?? "info";
    },
    async load() {
      this.loading = true;
      try {
        this.links = (await api.libraries.shareLinks(this.org, this.lib, this.query)).shareLinks;
      } catch (e) {
        this.links = [];
        if (e?.status !== 404) ElMessage.error(e.message || this.$t("errors.generic"));
      } finally {
        this.loading = false;
      }
    },
    async create() {
      this.error = "";
      const t = this.target;
      if (this.form.password && this.form.password.length < 8) {
        this.error = this.$t("share.passwordShort");
        return;
      }
      const target = t.kind === "file" ? { kind: "file", fileId: t.id } : t.kind === "folder" ? { kind: "folder", path: t.path } : { kind: "collection", collectionId: t.id };
      const body = { target, mode: this.form.mode };
      if (this.form.expiresIn) body.expiresIn = this.form.expiresIn;
      if (this.form.password) body.password = this.form.password;
      if (this.form.maxDownloads) body.maxDownloads = this.form.maxDownloads;
      this.busy = true;
      try {
        const r = await api.libraries.createShareLink(this.org, this.lib, body);
        this.created = r.url;
        this.form.password = "";
        await this.load();
      } catch (e) {
        this.error = e?.code === "public_sharing_off" ? this.$t("library.sharingOff") : e.message || this.$t("errors.generic");
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
        await api.libraries.revokeShareLink(this.org, this.lib, l.id);
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
.form {
  margin-bottom: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
.err {
  color: var(--el-color-danger);
}
.small {
  font-size: 0.8rem;
}
</style>
