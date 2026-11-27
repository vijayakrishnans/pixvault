<!-- Derived from MarSeventh/Sanyue-ImgHub@1621525:src/views/UploadHome.vue (MIT), modified.
     Kept: the drop zone, paste-to-upload and the per-file progress queue. Replaced: the channel picker and
     single-request upload with library uploads (hashed in the browser, resumable parts, verified on commit),
     and the page gains the library's files, its trash and the team's usage. -->
<template>
  <AppShell>
    <template #title>{{ library ? library.name : "" }}</template>

    <el-skeleton v-if="loading" :rows="6" animated />
    <el-result v-else-if="!library" icon="warning" :title="$t('notFound.title')" :sub-title="$t('notFound.body')" />
    <template v-else>
      <div class="head">
        <h1>{{ library.name }}</h1>
        <el-tag>{{ $t(`members.roles.${library.myRole}`) }}</el-tag>
        <span class="grow" />
        <router-link :to="{ name: 'librarySettings', params: { org, lib } }"><el-button>{{ $t("nav.settings") }}</el-button></router-link>
      </div>

      <div v-if="usage" class="usage pv-muted">
        <span>{{ $t("upload.usage", { used: fmt(usage.storageBytes), limit: fmt(usage.storageBytesLimit) }) }}</span>
        <el-progress :percentage="usagePct" :status="usagePct >= 100 ? 'exception' : usagePct >= 80 ? 'warning' : ''" :stroke-width="8" />
      </div>

      <section
        v-if="canUpload"
        class="drop pv-card"
        :class="{ over: dragging }"
        tabindex="0"
        role="button"
        :aria-label="$t('upload.drop')"
        @click="$refs.picker.click()"
        @keydown.enter.prevent="$refs.picker.click()"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <el-icon class="drop-icon"><Upload /></el-icon>
        <div class="drop-title">{{ $t("upload.drop") }}</div>
        <div class="pv-muted">{{ $t("upload.hint") }}</div>
        <input ref="picker" type="file" multiple hidden @change="onPick" />
      </section>

      <div v-if="canUpload" class="opts">
        <el-input v-model="folder" :placeholder="$t('upload.folder')" class="folder" clearable>
          <template #prepend><el-icon><Folder /></el-icon></template>
        </el-input>
        <el-radio-group v-model="visibility">
          <el-radio-button value="private">{{ $t("library.private") }}</el-radio-button>
          <el-radio-button value="public">{{ $t("library.public") }}</el-radio-button>
        </el-radio-group>
      </div>

      <ul v-if="queue.length" class="queue" aria-live="polite">
        <li v-for="q in queue" :key="q.key" class="pv-card item">
          <div class="item-top">
            <span class="item-name">{{ q.file.name }}</span>
            <span class="pv-muted">{{ fmt(q.file.size) }}</span>
          </div>
          <el-progress :percentage="Math.round(q.progress * 100)" :status="q.error ? 'exception' : q.phase === 'done' ? 'success' : ''" />
          <div class="item-status pv-muted">
            <span v-if="q.error">{{ q.error }}</span>
            <span v-else>{{ $t(`upload.phase.${q.phase}`) }}<span v-if="q.resumed"> · {{ $t("upload.resumed") }}</span><span v-if="q.dedup"> · {{ $t("upload.dedup") }}</span></span>
            <el-button v-if="q.conflict" size="small" text type="primary" @click="start(q, true)">{{ $t("upload.replace") }}</el-button>
            <el-button v-if="q.error && !q.conflict" size="small" text type="primary" @click="start(q)">{{ $t("upload.retry") }}</el-button>
          </div>
        </li>
      </ul>

      <el-tabs v-model="tab" class="tabs" @tab-change="loadFiles">
        <el-tab-pane :label="$t('upload.files')" name="files" />
        <el-tab-pane v-if="canTrash" :label="$t('upload.trash')" name="trash" />
      </el-tabs>
      <el-table v-loading="filesLoading" :data="files" :empty-text="tab === 'trash' ? $t('upload.trashEmpty') : $t('upload.empty')">
        <el-table-column :label="$t('upload.name')" min-width="220">
          <template #default="{ row }">
            <div class="fname">{{ row.name }}</div>
            <div class="pv-muted small">{{ row.folder }}</div>
          </template>
        </el-table-column>
        <el-table-column :label="$t('upload.size')" width="110">
          <template #default="{ row }">{{ fmt(row.size) }}</template>
        </el-table-column>
        <el-table-column :label="tab === 'trash' ? $t('upload.trashed') : $t('upload.uploaded')" width="170">
          <template #default="{ row }">{{ new Date(tab === "trash" ? row.trashedAt : row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column width="190" align="right">
          <template #default="{ row }">
            <template v-if="tab === 'files'">
              <el-button size="small" text @click="download(row)">{{ $t("upload.download") }}</el-button>
              <el-button v-if="canTrash" size="small" text type="danger" @click="trash(row)">{{ $t("upload.delete") }}</el-button>
            </template>
            <template v-else>
              <el-button size="small" text type="primary" @click="restore(row)">{{ $t("upload.restore") }}</el-button>
              <el-button size="small" text type="danger" @click="purge(row)">{{ $t("upload.purge") }}</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="nextCursor" class="more"><el-button @click="loadFiles(true)">{{ $t("upload.more") }}</el-button></div>
    </template>
  </AppShell>
</template>

<script>
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "@/api/client";
import { uploadFile } from "@/api/uploader";
import AppShell from "@/components/AppShell.vue";

const UNITS = ["B", "KB", "MB", "GB", "TB"];
let seq = 0;

export default {
  name: "LibraryHome",
  components: { AppShell },
  props: { org: { type: String, required: true }, lib: { type: String, required: true } },
  data: () => ({
    loading: true,
    library: null,
    usage: null,
    dragging: false,
    folder: "",
    visibility: "private",
    queue: [],
    tab: "files",
    files: [],
    nextCursor: null,
    filesLoading: false,
  }),
  computed: {
    canUpload() {
      return ["manager", "editor", "uploader"].includes(this.library?.myRole);
    },
    canTrash() {
      return ["manager", "editor"].includes(this.library?.myRole);
    },
    usagePct() {
      if (!this.usage) return 0;
      return Math.min(100, Math.round((this.usage.storageBytes / this.usage.storageBytesLimit) * 100));
    },
  },
  watch: {
    lib() {
      this.load();
    },
  },
  mounted() {
    this.load();
    window.addEventListener("paste", this.onPaste);
  },
  beforeUnmount() {
    window.removeEventListener("paste", this.onPaste);
  },
  methods: {
    fmt(n) {
      let i = 0;
      let v = n;
      while (v >= 1024 && i < UNITS.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${UNITS[i]}`;
    },
    async load() {
      this.loading = true;
      try {
        const r = await api.libraries.get(this.org, this.lib);
        this.library = r.library;
        this.visibility = r.library.visibilityDefault;
        await Promise.all([this.loadFiles(), this.loadUsage()]);
      } catch {
        this.library = null;
      } finally {
        this.loading = false;
      }
    },
    async loadUsage() {
      this.usage = (await api.libraries.usage(this.org).catch(() => null))?.usage ?? null;
    },
    async loadFiles(more = false) {
      if (more !== true) more = false;
      this.filesLoading = true;
      try {
        const r = await api.libraries.files(this.org, this.lib, { trash: this.tab === "trash", cursor: more ? this.nextCursor : undefined });
        this.files = more ? [...this.files, ...r.files] : r.files;
        this.nextCursor = r.nextCursor;
      } catch (e) {
        if (e?.status !== 404) ElMessage.error(e.message || this.$t("errors.generic"));
        this.files = [];
      } finally {
        this.filesLoading = false;
      }
    },
    enqueue(fileList) {
      for (const file of fileList) {
        const q = { key: ++seq, file, phase: "queued", progress: 0, error: "", conflict: false, resumed: false, dedup: false };
        this.queue.unshift(q);
        this.start(q);
      }
    },
    async start(q, replace = false) {
      q.error = "";
      q.conflict = false;
      try {
        const r = await uploadFile({
          org: this.org,
          lib: this.lib,
          file: q.file,
          folder: this.folder.trim() || "/",
          visibility: this.visibility,
          replace,
          onStatus: (s) => {
            q.phase = s.phase;
            if (typeof s.progress === "number") q.progress = s.phase === "hashing" ? s.progress * 0.1 : s.phase === "uploading" ? 0.1 + s.progress * 0.9 : s.progress;
          },
        });
        q.resumed = r.resumed;
        q.dedup = r.deduplicated;
        q.progress = 1;
        await Promise.all([this.loadFiles(), this.loadUsage()]);
      } catch (e) {
        q.conflict = e?.status === 409 && e?.code === "conflict";
        q.error = q.conflict ? this.$t("upload.exists") : e?.code === "quota_exceeded" ? e.message : e?.message || this.$t("errors.generic");
      }
    },
    onDrop(e) {
      this.dragging = false;
      if (e.dataTransfer?.files?.length) this.enqueue(e.dataTransfer.files);
    },
    onPick(e) {
      if (e.target.files?.length) this.enqueue(e.target.files);
      e.target.value = "";
    },
    onPaste(e) {
      if (!this.canUpload) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      // Pasted screenshots are all called "image.png": give each a unique, dated name.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.enqueue(files.map((f, i) => (f.name === "image.png" ? new File([f], `paste-${stamp}-${i}.png`, { type: f.type }) : f)));
    },
    async download(row) {
      try {
        const blob = await api.download(this.org, this.lib, row.id);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = row.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    async run(fn, done) {
      try {
        await fn();
        if (done) ElMessage.success(done);
        await Promise.all([this.loadFiles(), this.loadUsage()]);
      } catch (e) {
        ElMessage.error(e.message || this.$t("errors.generic"));
      }
    },
    trash(row) {
      return this.run(() => api.libraries.trashFile(this.org, this.lib, row.id), this.$t("upload.trashedMsg"));
    },
    restore(row) {
      return this.run(() => api.libraries.restoreFile(this.org, this.lib, row.id), this.$t("upload.restoredMsg"));
    },
    async purge(row) {
      try {
        await ElMessageBox.confirm(this.$t("upload.purgeConfirm", { name: row.name }), { type: "warning" });
      } catch {
        return;
      }
      return this.run(() => api.libraries.purgeFile(this.org, this.lib, row.id), this.$t("upload.purgedMsg"));
    },
  },
};
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.grow {
  flex: 1;
}
h1 {
  font-size: 1.5rem;
  margin: 0;
}
.usage {
  display: grid;
  gap: 4px;
  font-size: 0.85rem;
  max-width: 420px;
  margin-bottom: 16px;
}
.drop {
  display: grid;
  place-items: center;
  gap: 6px;
  padding: 36px 16px;
  border: 2px dashed var(--pv-border);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.2s, background 0.2s;
}
.drop.over,
.drop:hover {
  border-color: var(--pv-brand);
  background: var(--pv-brand-soft);
}
.drop-icon {
  font-size: 2rem;
  color: var(--pv-brand);
}
.drop-title {
  font-weight: 600;
}
.opts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0;
}
.folder {
  max-width: 320px;
}
.queue {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  display: grid;
  gap: 8px;
}
.item {
  padding: 12px 16px;
}
.item-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.item-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85rem;
  min-height: 24px;
}
.tabs {
  margin-top: 8px;
}
.fname {
  overflow-wrap: anywhere;
}
.small {
  font-size: 0.78rem;
}
.more {
  text-align: center;
  margin-top: 12px;
}
</style>
