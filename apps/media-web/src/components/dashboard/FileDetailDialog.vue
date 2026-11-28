<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/components/dashboard/FileDetailDialog.vue (MIT), modified.
     Kept: one panel per file with a preview (image, video or audio), its details and the actions on it (download,
     rename, delete). Replaced: the dialog with a side drawer; the channel, block and allow-list actions and the
     free-form metadata editor with the library's own: links, move, rename, visibility, and the version history with
     restore. A private file's preview uses a short signed link fetched when the drawer opens. -->
<template>
  <el-drawer :model-value="!!file" :title="file ? file.name : ''" :size="drawerSize" append-to-body data-test="file-drawer" @close="$emit('close')">
    <template v-if="file">
      <div class="preview">
        <img v-if="kind === 'image' && previewUrl" :src="previewUrl" :alt="file.name" />
        <video v-else-if="kind === 'video' && mediaUrl" :src="mediaUrl" controls preload="metadata" />
        <audio v-else-if="kind === 'audio' && mediaUrl" :src="mediaUrl" controls preload="metadata" />
        <el-icon v-else class="big-icon"><Document /></el-icon>
      </div>

      <div class="actions">
        <el-button v-if="served" size="small" type="primary" data-test="drawer-links" @click="$emit('links', file)">{{ $t("links.open") }}</el-button>
        <el-button size="small" @click="$emit('download', file)">{{ $t("upload.download") }}</el-button>
        <el-button v-if="canEdit && file.status !== 'removed'" size="small" data-test="drawer-move" @click="$emit('move', file)">{{ $t("browse.move") }}</el-button>
        <el-button v-if="canEdit && served" size="small" data-test="drawer-share" @click="$emit('share', file)">{{ $t("share.button") }}</el-button>
        <el-button v-if="canTrash" size="small" type="danger" plain @click="$emit('trash', file)">{{ $t("upload.delete") }}</el-button>
      </div>

      <el-form v-if="canEdit && file.status !== 'removed'" class="rename" @submit.prevent="rename">
        <el-input v-model="newName" size="small" :aria-label="$t('browse.rename')" data-test="rename-input">
          <template #append><el-button :loading="saving" :disabled="!renameValid" data-test="rename-save" @click="rename">{{ $t("browse.rename") }}</el-button></template>
        </el-input>
      </el-form>

      <el-descriptions :column="1" size="small" border class="meta">
        <el-descriptions-item :label="$t('browse.state')">
          <el-tag size="small" :type="stateType">{{ $t(`status.${file.status}`) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item :label="$t('browse.folder')">{{ file.folder }}</el-descriptions-item>
        <el-descriptions-item :label="$t('upload.size')">{{ fmt(file.size) }}</el-descriptions-item>
        <el-descriptions-item :label="$t('browse.type')">{{ file.mime }}</el-descriptions-item>
        <el-descriptions-item v-if="file.width && file.height" :label="$t('browse.dimensions')">{{ file.width }} × {{ file.height }}</el-descriptions-item>
        <el-descriptions-item :label="$t('upload.uploaded')">{{ new Date(file.createdAt).toLocaleString() }}</el-descriptions-item>
        <el-descriptions-item :label="$t('browse.uploadedBy')">{{ who(file.uploadedBy) }}</el-descriptions-item>
        <el-descriptions-item v-if="file.tags && file.tags.length" :label="$t('browse.tags')">
          <el-tag v-for="t in file.tags" :key="t" size="small" class="tag" effect="plain">{{ t }}</el-tag>
        </el-descriptions-item>
      </el-descriptions>

      <h3 class="section">{{ $t("browse.versions") }}</h3>
      <el-skeleton v-if="versionsLoading" :rows="2" animated />
      <ul v-else class="versions" data-test="versions">
        <li v-for="v in versions" :key="v.version">
          <span class="v">v{{ v.version }}</span>
          <span class="pv-muted small">{{ new Date(v.createdAt).toLocaleString() }} · {{ fmt(v.size) }}</span>
          <el-tag v-if="v.current" size="small" type="success">{{ $t("browse.current") }}</el-tag>
          <el-button v-else-if="canEdit && file.status !== 'removed'" size="small" text type="primary" data-test="restore-version" @click="restoreVersion(v)">{{ $t("browse.restoreVersion") }}</el-button>
        </li>
      </ul>

      <CommentsPanel ref="comments" :org="org" :lib="lib" :file-id="file.id" :names="names" :me="me" :can-moderate="canEdit" />

      <h3 class="section">{{ $t("activity.title") }}</h3>
      <ActivityList ref="activity" :org="org" :lib="lib" :file-id="file.id" :names="names" />
    </template>
  </el-drawer>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import { fileKind, thumbUrl, withPreset } from "@/utils/browse";
import CommentsPanel from "@/components/CommentsPanel.vue";
import ActivityList from "@/components/ActivityList.vue";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export default {
  name: "FileDetailDialog",
  components: { CommentsPanel, ActivityList },
  props: {
    file: { type: Object, default: null },
    org: { type: String, required: true },
    lib: { type: String, required: true },
    canEdit: { type: Boolean, default: false },
    canTrash: { type: Boolean, default: false },
    /** subject id → a name to show (from the library's members). */
    names: { type: Object, default: () => ({}) },
    me: { type: String, default: null },
  },
  emits: ["close", "links", "download", "move", "trash", "updated", "share"],
  data: () => ({ signed: null, versions: [], versionsLoading: false, newName: "", saving: false }),
  computed: {
    kind() {
      return fileKind(this.file?.mime);
    },
    served() {
      return this.file?.status === "public" || this.file?.status === "private";
    },
    previewUrl() {
      return thumbUrl(this.file, "medium") ?? (this.signed ? withPreset(this.signed, "medium") : null);
    },
    mediaUrl() {
      return this.file?.status === "public" ? this.file.url : this.signed;
    },
    stateType() {
      return { public: "success", private: "info", processing: "info", held: "warning", flagged: "danger", removed: "danger" }[this.file?.status] ?? "info";
    },
    renameValid() {
      const n = this.newName.trim();
      return n && n !== this.file?.name && n.length <= 255 && !n.includes("/");
    },
    drawerSize() {
      return globalThis.innerWidth && globalThis.innerWidth < 640 ? "100%" : "420px";
    },
  },
  watch: {
    "file.id": {
      immediate: true,
      handler() {
        this.signed = null;
        this.versions = [];
        if (!this.file) return;
        this.newName = this.file.name;
        this.loadVersions();
        this.loadPreview();
      },
    },
    "file.name"(n) {
      if (n) this.newName = n;
    },
  },
  methods: {
    /** A teammate changed this file's comments (live event). */
    reloadComments() {
      this.$refs.comments?.reload();
      this.$refs.activity?.reload();
    },
    reloadActivity() {
      this.$refs.activity?.reload();
    },
    fmt(n) {
      let i = 0;
      let v = n;
      while (v >= 1024 && i < UNITS.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
    },
    who(sub) {
      if (String(sub).startsWith("upl_")) return this.$t("browse.viaUploadLink");
      return this.names[sub] ?? sub;
    },
    async loadVersions() {
      const id = this.file.id;
      this.versionsLoading = true;
      try {
        const r = await api.libraries.versions(this.org, this.lib, id);
        if (this.file?.id === id) this.versions = r.versions;
      } catch {
        this.versions = [];
      } finally {
        this.versionsLoading = false;
      }
    },
    async loadPreview() {
      // Public files preview from their own URL; a private image, video or audio gets a 10-minute signed link.
      if (this.file.status !== "private" || this.kind === "document" || this.kind === "other") return;
      const id = this.file.id;
      try {
        const r = await api.libraries.signedUrl(this.org, this.lib, id, 600);
        if (this.file?.id === id) this.signed = r.url;
      } catch {
        this.signed = null;
      }
    },
    async rename() {
      if (!this.renameValid) return;
      this.saving = true;
      try {
        const r = await api.libraries.moveFile(this.org, this.lib, this.file.id, { name: this.newName.trim() });
        ElMessage.success(this.$t("browse.renamed"));
        this.$emit("updated", r.file);
      } catch (e) {
        ElMessage.error(e?.status === 409 ? this.$t("upload.exists") : e.message || this.$t("errors.generic"));
      } finally {
        this.saving = false;
      }
    },
    async restoreVersion(v) {
      try {
        await ElMessageBox.confirm(this.$t("browse.restoreConfirm", { v: v.version }), { type: "warning" });
      } catch {
        return;
      }
      try {
        const r = await api.libraries.restoreVersion(this.org, this.lib, this.file.id, v.version);
        ElMessage.success(this.$t("browse.versionRestored", { v: v.version }));
        this.$emit("updated", r.file);
        await this.loadVersions();
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
  },
};
</script>

<style scoped>
.preview {
  display: grid;
  place-items: center;
  min-height: 160px;
  background: var(--pv-brand-soft);
  border-radius: 10px;
  overflow: hidden;
}
.preview img,
.preview video {
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
.preview audio {
  width: 90%;
}
.big-icon {
  font-size: 3rem;
  color: var(--pv-brand);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.rename {
  margin-bottom: 12px;
}
.meta {
  margin-bottom: 16px;
}
.tag {
  margin: 0 4px 4px 0;
}
.section {
  font-size: 0.95rem;
  margin: 8px 0;
}
.versions {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 6px;
}
.versions li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.v {
  font-weight: 600;
  min-width: 2.5em;
}
.small {
  font-size: 0.8rem;
}
</style>
